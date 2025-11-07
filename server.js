const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
require('dotenv').config();

const { db, logActivity, createUserTaskFolder, saveTaskMetadata, updateTaskMetadata, checkTaskAccess } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Статические файлы из папки data/uploads
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// Сессии
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Middleware для проверки аутентификации
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Требуется аутентификация' });
    }
    next();
};

// Настройка Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const taskId = req.body.taskId || req.params.taskId;
        const userLogin = req.session.user.login;
        
        if (taskId) {
            const userFolder = createUserTaskFolder(taskId, userLogin);
            cb(null, userFolder);
        } else {
            const tempDir = path.join(__dirname, 'data', 'uploads', 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            cb(null, tempDir);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 300 * 1024 * 1024,
        files: 15
    }
});

// Вспомогательная функция
const createDirIfNotExists = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

// Вспомогательная функция для проверки просрочки
function checkIfOverdue(dueDate, status) {
    if (!dueDate || status === 'completed') return false;
    const now = new Date();
    const due = new Date(dueDate);
    return due < now;
}

// ==================== МАРШРУТЫ АУТЕНТИФИКАЦИИ ====================

app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }

    try {
        const user = await authService.authenticate(login, password);
        if (user) {
            req.session.user = user;
            
            // Логируем успешный вход
            console.log(`Успешная авторизация: ${user.name} (${user.login}) через ${user.auth_type}`);
            if (user.groups) {
                console.log(`Группы пользователя: ${user.groups}`);
            }
            
            res.json({ 
                success: true, 
                user: {
                    id: user.id,
                    login: user.login,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    auth_type: user.auth_type,
                    groups: user.groups ? JSON.parse(user.groups) : []
                }
            });
        } else {
            console.log(`Неудачная попытка входа: ${login}`);
            res.status(401).json({ error: 'Неверный логин или пароль' });
        }
    } catch (error) {
        console.error('Ошибка аутентификации:', error);
        res.status(500).json({ error: 'Ошибка сервера при авторизации' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/user', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.status(401).json({ error: 'Не аутентифицирован' });
    }
});

// ==================== МАРШРУТЫ ПОЛЬЗОВАТЕЛЕЙ ====================

app.get('/api/users', requireAuth, (req, res) => {
    db.all("SELECT id, login, name, email, role, auth_type FROM users WHERE role IN ('admin', 'teacher') ORDER BY name", (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// ==================== МАРШРУТЫ ЗАДАЧ ====================

// Получить задачи с учетом прав доступа
app.get('/api/tasks', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    const showDeleted = req.session.user.role === 'admin';

    let query = `
        SELECT DISTINCT
            t.*,
            u.name as creator_name,
            u.login as creator_login,
            ot.title as original_task_title,
            ou.name as original_creator_name,
            GROUP_CONCAT(DISTINCT ta.user_id) as assigned_user_ids,
            GROUP_CONCAT(DISTINCT u2.name) as assigned_user_names
        FROM tasks t
        LEFT JOIN users u ON t.created_by = u.id
        LEFT JOIN tasks ot ON t.original_task_id = ot.id
        LEFT JOIN users ou ON ot.created_by = ou.id
        LEFT JOIN task_assignments ta ON t.id = ta.task_id
        LEFT JOIN users u2 ON ta.user_id = u2.id
        WHERE 1=1
    `;

    // Для обычных пользователей показываем только задачи где они заказчик или исполнитель
    if (req.session.user.role !== 'admin') {
        query += ` AND (t.created_by = ${userId} OR ta.user_id = ${userId})`;
    }

    if (!showDeleted) {
        query += " AND t.status = 'active'";
    }

    query += " GROUP BY t.id ORDER BY t.created_at DESC";

    db.all(query, (err, tasks) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        const taskPromises = tasks.map(task => {
            return new Promise((resolve) => {
                db.all(`
                    SELECT ta.*, u.name as user_name, u.login as user_login
                    FROM task_assignments ta 
                    LEFT JOIN users u ON ta.user_id = u.id 
                    WHERE ta.task_id = ?
                `, [task.id], (err, assignments) => {
                    if (err) {
                        task.assignments = [];
                        resolve(task);
                        return;
                    }

                    // Проверяем просрочку для каждого назначения
                    assignments.forEach(assignment => {
                        if (checkIfOverdue(assignment.due_date, assignment.status) && assignment.status !== 'completed') {
                            assignment.status = 'overdue';
                        }
                    });

                    task.assignments = assignments || [];
                    resolve(task);
                });
            });
        });

        Promise.all(taskPromises).then(completedTasks => {
            res.json(completedTasks);
        });
    });
});

// Создать задачу
app.post('/api/tasks', requireAuth, upload.array('files', 15), (req, res) => {
    const { title, description, assignedUsers, originalTaskId, startDate, dueDate } = req.body;
    const createdBy = req.session.user.id;

    if (!title) {
        return res.status(400).json({ error: 'Название задачи обязательно' });
    }

    db.serialize(() => {
        db.run(
            "INSERT INTO tasks (title, description, created_by, original_task_id, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?)",
            [title, description, createdBy, originalTaskId || null, startDate || null, dueDate || null],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                const taskId = this.lastID;

                // Создаем папку задачи и сохраняем метаданные
                saveTaskMetadata(taskId, title, description, createdBy, originalTaskId, startDate, dueDate);

                const action = originalTaskId ? 'TASK_COPIED' : 'TASK_CREATED';
                const details = originalTaskId ? 
                    `Создана копия задачи: ${title}` : 
                    `Создана задача: ${title}`;

                logActivity(taskId, createdBy, action, details);

                // Обрабатываем файлы
                if (req.files && req.files.length > 0) {
                    const userFolder = createUserTaskFolder(taskId, req.session.user.login);
                    
                    req.files.forEach(file => {
                        const newPath = path.join(userFolder, path.basename(file.filename));
                        fs.renameSync(file.path, newPath);

                        db.run(
                            "INSERT INTO task_files (task_id, user_id, filename, original_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)",
                            [taskId, createdBy, path.basename(file.filename), file.originalname, newPath, file.size]
                        );

                        logActivity(taskId, createdBy, 'FILE_UPLOADED', `Загружен файл: ${file.originalname}`);
                    });

                    // Очищаем временную папку
                    const tempDir = path.join(__dirname, 'data', 'uploads', 'temp');
                    if (fs.existsSync(tempDir)) {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                }

                // Назначаем пользователей
                if (assignedUsers) {
                    const userIds = Array.isArray(assignedUsers) ? assignedUsers : [assignedUsers];
                    
                    userIds.forEach(userId => {
                        db.run(
                            "INSERT INTO task_assignments (task_id, user_id, start_date, due_date) VALUES (?, ?, ?, ?)",
                            [taskId, userId, startDate || null, dueDate || null]
                        );

                        logActivity(taskId, createdBy, 'TASK_ASSIGNED', `Задача назначена пользователю ${userId}`);
                    });
                }

                res.json({ 
                    success: true, 
                    taskId: taskId,
                    message: originalTaskId ? 'Копия задачи создана' : 'Задача успешно создана'
                });
            }
        );
    });
});

// Копировать задачу
app.post('/api/tasks/:taskId/copy', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const { assignedUsers, startDate, dueDate } = req.body;
    const createdBy = req.session.user.id;

    // Проверяем доступ к оригинальной задаче
    checkTaskAccess(createdBy, taskId, (err, hasAccess) => {
        if (err || !hasAccess) {
            return res.status(404).json({ error: 'Задача не найдена или у вас нет прав доступа' });
        }

        db.serialize(() => {
            // Получаем данные оригинальной задачи
            db.get("SELECT title, description FROM tasks WHERE id = ?", [taskId], (err, originalTask) => {
                if (err || !originalTask) {
                    return res.status(404).json({ error: 'Оригинальная задача не найдена' });
                }

                // Создаем копию задачи
                const newTitle = `Копия: ${originalTask.title}`;
                
                db.run(
                    "INSERT INTO tasks (title, description, created_by, original_task_id, start_date, due_date) VALUES (?, ?, ?, ?, ?, ?)",
                    [newTitle, originalTask.description, createdBy, taskId, startDate || null, dueDate || null],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        const newTaskId = this.lastID;

                        // Создаем папку задачи и сохраняем метаданные
                        saveTaskMetadata(newTaskId, newTitle, originalTask.description, createdBy, taskId, startDate, dueDate);

                        logActivity(newTaskId, createdBy, 'TASK_COPIED', `Создана копия задачи: ${newTitle}`);

                        // Назначаем пользователей
                        if (assignedUsers && assignedUsers.length > 0) {
                            assignedUsers.forEach(userId => {
                                db.run(
                                    "INSERT INTO task_assignments (task_id, user_id, start_date, due_date) VALUES (?, ?, ?, ?)",
                                    [newTaskId, userId, startDate || null, dueDate || null]
                                );
                            });
                            
                            logActivity(newTaskId, createdBy, 'TASK_ASSIGNED', `Задача назначена пользователям: ${assignedUsers.join(', ')}`);
                        }

                        res.json({ 
                            success: true, 
                            taskId: newTaskId,
                            message: 'Копия задачи успешно создана'
                        });
                    }
                );
            });
        });
    });
});

// Получить задачу по ID с проверкой прав
app.get('/api/tasks/:taskId', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    checkTaskAccess(userId, taskId, (err, hasAccess) => {
        if (err || !hasAccess) {
            return res.status(404).json({ error: 'Задача не найдена или у вас нет прав доступа' });
        }

        const showDeleted = req.session.user.role === 'admin';
        let query = `
            SELECT 
                t.*,
                u.name as creator_name,
                u.login as creator_login,
                ot.title as original_task_title,
                ou.name as original_creator_name
            FROM tasks t
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN tasks ot ON t.original_task_id = ot.id
            LEFT JOIN users ou ON ot.created_by = ou.id
            WHERE t.id = ?
        `;

        if (!showDeleted) {
            query += " AND t.status = 'active'";
        }

        db.get(query, [taskId], (err, task) => {
            if (err || !task) {
                return res.status(404).json({ error: 'Задача не найдена' });
            }

            // Получаем назначения
            db.all(`
                SELECT ta.*, u.name as user_name, u.login as user_login
                FROM task_assignments ta 
                LEFT JOIN users u ON ta.user_id = u.id 
                WHERE ta.task_id = ?
            `, [taskId], (err, assignments) => {
                if (err) {
                    task.assignments = [];
                    res.json(task);
                    return;
                }

                // Проверяем просрочку для каждого назначения
                assignments.forEach(assignment => {
                    if (checkIfOverdue(assignment.due_date, assignment.status) && assignment.status !== 'completed') {
                        assignment.status = 'overdue';
                    }
                });

                task.assignments = assignments || [];
                res.json(task);
            });
        });
    });
});

// Обновить задачу с проверкой прав
app.put('/api/tasks/:taskId', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const { title, description, assignedUsers, startDate, dueDate } = req.body;
    const userId = req.session.user.id;

    if (!title) {
        return res.status(400).json({ error: 'Название задачи обязательно' });
    }

    // Проверяем права - только создатель или администратор могут редактировать
    db.get("SELECT created_by FROM tasks WHERE id = ? AND status = 'active'", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== userId) {
            return res.status(403).json({ error: 'У вас нет прав для редактирования этой задачи' });
        }

        db.serialize(() => {
            // Обновляем задачу
            db.run(
                "UPDATE tasks SET title = ?, description = ?, start_date = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [title, description, startDate || null, dueDate || null, taskId],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    // Обновляем метаданные
                    updateTaskMetadata(taskId, { title, description, start_date: startDate, due_date: dueDate });

                    logActivity(taskId, userId, 'TASK_UPDATED', `Задача обновлена: ${title}`);

                    // Обновляем назначения если переданы
                    if (assignedUsers) {
                        // Удаляем старые назначения
                        db.run("DELETE FROM task_assignments WHERE task_id = ?", [taskId], (err) => {
                            if (err) {
                                console.error('Ошибка удаления старых назначений:', err);
                            }

                            // Добавляем новые назначения
                            const userIds = Array.isArray(assignedUsers) ? assignedUsers : [assignedUsers];
                            userIds.forEach(userId => {
                                db.run(
                                    "INSERT INTO task_assignments (task_id, user_id, start_date, due_date) VALUES (?, ?, ?, ?)",
                                    [taskId, userId, startDate || null, dueDate || null]
                                );
                            });

                            logActivity(taskId, userId, 'TASK_ASSIGNMENTS_UPDATED', `Назначения обновлены`);
                        });
                    }

                    res.json({ success: true, message: 'Задача обновлена' });
                }
            );
        });
    });
});

// Обновить сроки для конкретного исполнителя
app.put('/api/tasks/:taskId/assignment/:userId', requireAuth, (req, res) => {
    const { taskId, userId } = req.params;
    const { startDate, dueDate } = req.body;
    const currentUserId = req.session.user.id;

    // Проверяем права - только создатель или администратор могут редактировать сроки
    db.get("SELECT created_by FROM tasks WHERE id = ?", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== currentUserId) {
            return res.status(403).json({ error: 'У вас нет прав для редактирования сроков' });
        }

        db.run(
            "UPDATE task_assignments SET start_date = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND user_id = ?",
            [startDate || null, dueDate || null, taskId, userId],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Назначение не найдено' });
                }

                logActivity(taskId, currentUserId, 'ASSIGNMENT_UPDATED', `Обновлены сроки для пользователя ${userId}`);
                res.json({ success: true, message: 'Сроки обновлены' });
            }
        );
    });
});

// Удалить задачу с проверкой прав
app.delete('/api/tasks/:taskId', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    // Проверяем права - только создатель или администратор могут удалять
    db.get("SELECT created_by FROM tasks WHERE id = ? AND status = 'active'", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== userId) {
            return res.status(403).json({ error: 'У вас нет прав для удаления этой задачи' });
        }

        // Помечаем задачу как удаленную
        db.run(
            "UPDATE tasks SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?",
            [userId, taskId],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                // Обновляем метаданные
                updateTaskMetadata(taskId, { 
                    status: 'deleted', 
                    deleted_at: new Date().toISOString(),
                    deleted_by: userId
                });

                logActivity(taskId, userId, 'TASK_DELETED', `Задача помечена как удаленная`);

                res.json({ success: true, message: 'Задача удалена' });
            }
        );
    });
});

// Восстановить задачу
app.post('/api/tasks/:taskId/restore', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    // Только администратор может восстанавливать задачи
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав' });
    }

    db.run(
        "UPDATE tasks SET status = 'active', deleted_at = NULL, deleted_by = NULL WHERE id = ?",
        [taskId],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Задача не найдена' });
            }

            updateTaskMetadata(taskId, { 
                status: 'active', 
                deleted_at: null,
                deleted_by: null
            });

            logActivity(taskId, userId, 'TASK_RESTORED', `Задача восстановлена`);

            res.json({ success: true, message: 'Задача восстановлена' });
        }
    );
});

// ==================== МАРШРУТЫ СТАТУСОВ ====================

// Обновить статус задачи
app.put('/api/tasks/:taskId/status', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const { userId: targetUserId, status } = req.body;
    const currentUserId = req.session.user.id;

    // Проверяем, что пользователь обновляет свой статус
    if (parseInt(targetUserId) !== currentUserId) {
        return res.status(403).json({ error: 'Недостаточно прав' });
    }

    if (!targetUserId || !status) {
        return res.status(400).json({ error: 'userId и status обязательны' });
    }

    // Проверяем, что пользователь назначен на эту задачу
    db.get("SELECT 1 FROM task_assignments WHERE task_id = ? AND user_id = ?", [taskId, currentUserId], (err, assignment) => {
        if (err || !assignment) {
            return res.status(403).json({ error: 'Вы не назначены на эту задачу' });
        }

        // Если задача помечается как выполненная и она просрочена, оставляем статус completed
        const finalStatus = status === 'completed' ? 'completed' : status;

        db.run(
            "UPDATE task_assignments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND user_id = ?",
            [finalStatus, taskId, targetUserId],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                if (this.changes === 0) {
                    res.status(404).json({ error: 'Назначение не найдено' });
                    return;
                }

                logActivity(taskId, targetUserId, 'STATUS_CHANGED', `Статус изменен на: ${finalStatus}`);
                res.json({ success: true, message: 'Статус обновлен' });
            }
        );
    });
});

// ==================== МАРШРУТЫ ФАЙЛОВ ====================

// Добавить файлы к задаче
app.post('/api/tasks/:taskId/files', requireAuth, upload.array('files', 15), (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Нет файлов для загрузки' });
    }

    // Проверяем доступ к задаче
    checkTaskAccess(userId, taskId, (err, hasAccess) => {
        if (err || !hasAccess) {
            return res.status(404).json({ error: 'Задача не найдена или у вас нет прав доступа' });
        }

        req.files.forEach(file => {
            db.run(
                "INSERT INTO task_files (task_id, user_id, filename, original_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)",
                [taskId, userId, path.basename(file.filename), file.originalname, file.path, file.size]
            );

            logActivity(taskId, userId, 'FILE_UPLOADED', `Загружен файл: ${file.originalname}`);
        });

        res.json({ success: true, message: 'Файлы успешно загружены' });
    });
});

// Получить файлы задачи
app.get('/api/tasks/:taskId/files', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    // Проверяем доступ к задаче
    checkTaskAccess(userId, taskId, (err, hasAccess) => {
        if (err || !hasAccess) {
            return res.status(404).json({ error: 'Задача не найдена или у вас нет прав доступа' });
        }

        db.all(`
            SELECT tf.*, u.name as user_name, u.login as user_login
            FROM task_files tf 
            LEFT JOIN users u ON tf.user_id = u.id 
            WHERE tf.task_id = ?
            ORDER BY tf.uploaded_at DESC
        `, [taskId], (err, files) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json(files);
        });
    });
});

// Скачать файл
app.get('/api/files/:fileId/download', requireAuth, (req, res) => {
    const { fileId } = req.params;
    const userId = req.session.user.id;

    db.get("SELECT tf.*, t.id as task_id FROM task_files tf JOIN tasks t ON tf.task_id = t.id WHERE tf.id = ?", [fileId], (err, file) => {
        if (err || !file) {
            return res.status(404).json({ error: 'Файл не найдена' });
        }

        // Проверяем доступ к задаче файла
        checkTaskAccess(userId, file.task_id, (err, hasAccess) => {
            if (err || !hasAccess) {
                return res.status(404).json({ error: 'Файл не найден или у вас нет прав доступа' });
            }

            if (!fs.existsSync(file.file_path)) {
                return res.status(404).json({ error: 'Файл не найден на сервере' });
            }

            res.download(file.file_path, file.original_name);
        });
    });
});

// ==================== МАРШРУТЫ ЛОГОВ ====================

app.get('/api/activity-logs', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    
    let query = `
        SELECT al.*, u.name as user_name, t.title as task_title
        FROM activity_logs al
        LEFT JOIN users u ON al.user_id = u.id
        LEFT JOIN tasks t ON al.task_id = t.id
        WHERE 1=1
    `;

    // Для обычных пользователей показываем только логи их задач
    if (req.session.user.role !== 'admin') {
        query += ` AND (t.created_by = ${userId} OR al.task_id IN (
            SELECT task_id FROM task_assignments WHERE user_id = ${userId}
        ))`;
    }

    query += " ORDER BY al.created_at DESC LIMIT 100";

    db.all(query, (err, logs) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(logs);
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`CRM сервер запущен на порту ${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в браузере`);
    console.log('Данные хранятся в папке:', path.join(__dirname, 'data'));
    console.log('Тестовые пользователи:');
    console.log('- Логин: director, Пароль: director123 (Администратор)');
    console.log('- Логин: zavuch, Пароль: zavuch123');
    console.log('- Логин: teacher, Пароль: teacher123');
    console.log('LDAP авторизация доступна для пользователей школы');
    console.log(`Разрешенные группы: ${process.env.ALLOWED_GROUPS}`);
});