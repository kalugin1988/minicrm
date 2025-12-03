const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const fetch = require('node-fetch');
require('dotenv').config();

const { db, logActivity, createUserTaskFolder, saveTaskMetadata, updateTaskMetadata, checkTaskAccess } = require('./database');
const authService = require('./auth'); 

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
    secret: process.env.SESSION_SECRET || 'fallback_secret_change_in_production',
    resave: true,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
    }
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

// Функция для проверки просроченных задач
function checkOverdueTasks() {
    const now = new Date().toISOString();
    
    // Проверяем только активные незакрытые задачи
    const query = `
        SELECT ta.id, ta.task_id, ta.user_id, ta.status, ta.due_date
        FROM task_assignments ta
        JOIN tasks t ON ta.task_id = t.id
        WHERE ta.due_date IS NOT NULL 
        AND ta.due_date < ? 
        AND ta.status NOT IN ('completed', 'overdue')
        AND t.status = 'active'
        AND t.closed_at IS NULL
    `;

    db.all(query, [now], (err, assignments) => {
        if (err) {
            console.error('Ошибка при проверке просроченных задач:', err);
            return;
        }

        assignments.forEach(assignment => {
            db.run(
                "UPDATE task_assignments SET status = 'overdue' WHERE id = ?",
                [assignment.id]
            );
            logActivity(assignment.task_id, assignment.user_id, 'STATUS_CHANGED', 'Задача просрочена');
        });
    });
}

// ==================== СИСТЕМА УВЕДОМЛЕНИЙ ====================

/**
 * Кодирование логина и пароля в Base64 для Basic Auth
 */
function encodeBasicAuth(login, password) {
    return Buffer.from(`${login}:${password}`).toString('base64');
}

/**
 * Отправка уведомлений всем участникам задачи
 * @param {string} type - Тип события: 'created', 'updated', 'rework', 'closed', 'status_changed'
 * @param {number} taskId - ID задачи
 * @param {string} taskTitle - Название задачи
 * @param {string} taskDescription - Описание задачи
 * @param {number} authorId - ID автора изменения
 * @param {string} comment - Комментарий (для доработки)
 * @param {string} status - Новый статус (для status_changed)
 * @param {string} userName - Имя пользователя, изменившего статус
 */
async function sendTaskNotifications(type, taskId, taskTitle, taskDescription, authorId, comment = '', status = '', userName = '') {
    try {
        // Проверяем наличие настроек уведомлений
        if (!process.env.NOTIFICATION_SERVICE_URL || 
            !process.env.NOTIFICATION_SERVICE_LOGIN || 
            !process.env.NOTIFICATION_SERVICE_PASSWORD) {
            console.log('Настройки сервиса уведомлений не заданы');
            return;
        }

        // Получаем ВСЕХ участников задачи (создателя + исполнителей)
        const participants = await new Promise((resolve, reject) => {
            db.all(`
                -- Получаем создателя задачи
                SELECT t.created_by as user_id, u.name as user_name, u.login as user_login, u.email, 'creator' as role
                FROM tasks t
                LEFT JOIN users u ON t.created_by = u.id
                WHERE t.id = ?
                
                UNION
                
                -- Получаем всех исполнителей
                SELECT ta.user_id, u.name as user_name, u.login as user_login, u.email, 'assignee' as role
                FROM task_assignments ta
                LEFT JOIN users u ON ta.user_id = u.id
                WHERE ta.task_id = ?
            `, [taskId, taskId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (!participants || participants.length === 0) {
            console.log('Нет участников для уведомления');
            return;
        }

        // Получаем информацию об авторе изменения
        const author = await new Promise((resolve, reject) => {
            db.get("SELECT name FROM users WHERE id = ?", [authorId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        const authorName = author ? author.name : 'Система';

        // Формируем текст уведомления в зависимости от типа события
        let subject, content;

        switch (type) {
            case 'created':
                subject = `Новая задача: ${taskTitle}`;
                content = `Создана новая задача:\n\n` +
                         `📋 ${taskTitle}\n` +
                         `📝 ${taskDescription || 'Без описания'}\n` +
                         `👤 Автор: ${authorName}\n\n` +
                         `Для просмотра перейдите в систему управления задачами.`;
                break;

            case 'updated':
                subject = `Обновлена задача: ${taskTitle}`;
                content = `Задача была обновлена:\n\n` +
                         `📋 ${taskTitle}\n` +
                         `📝 ${taskDescription || 'Без описания'}\n` +
                         `👤 Изменено: ${authorName}\n\n` +
                         `Для просмотра изменений перейдите в систему управления задачами.`;
                break;

            case 'rework':
                subject = `Задача возвращена на доработку: ${taskTitle}`;
                content = `Задача возвращена на доработку:\n\n` +
                         `📋 ${taskTitle}\n` +
                         `📝 Комментарий: ${comment}\n` +
                         `👤 Автор замечания: ${authorName}\n\n` +
                         `Пожалуйста, исправьте замечания и обновите статус задачи.`;
                break;

            case 'closed':
                subject = `Задача закрыта: ${taskTitle}`;
                content = `Задача была закрыта:\n\n` +
                         `📋 ${taskTitle}\n` +
                         `👤 Закрыта: ${authorName}\n\n` +
                         `Задача завершена и перемещена в архив.`;
                break;

            case 'status_changed':
                const statusText = getStatusText(status);
                subject = `Изменен статус задачи: ${taskTitle}`;
                content = `Статус задачи изменен:\n\n` +
                         `📋 ${taskTitle}\n` +
                         `🔄 Новый статус: ${statusText}\n` +
                         `👤 Изменил: ${userName || authorName}\n\n` +
                         `Для просмотра перейдите в систему управления задачами.`;
                break;

            default:
                return;
        }

        // Формируем список ID получателей (исключаем автора изменения, чтобы он не получал уведомление о своем действии)
        const recipientIds = participants
            .filter(p => p.user_id !== authorId) // Исключаем автора действия
            .map(p => p.user_id);

        // Если после фильтрации не осталось получателей, выходим
        if (recipientIds.length === 0) {
            console.log('Нет получателей для уведомления (все участники - автор изменения)');
            return;
        }

        // Кодируем логин и пароль для Basic Auth
        const authHeader = encodeBasicAuth(
            process.env.NOTIFICATION_SERVICE_LOGIN,
            process.env.NOTIFICATION_SERVICE_PASSWORD
        );

        // Создаем FormData для отправки
        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('subject', subject);
        formData.append('content', content);
        formData.append('recipients', JSON.stringify(recipientIds));
        formData.append('deliveryMethods', JSON.stringify(['email', 'telegram', 'vk']));

        // Отправляем уведомление
        const response = await fetch(process.env.NOTIFICATION_SERVICE_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authHeader}`
            },
            body: formData
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log(`✅ Уведомления отправлены для задачи ${taskId}:`, {
            type: type,
            recipients: recipientIds.length,
            authorExcluded: authorId
        });

    } catch (error) {
        console.error('❌ Ошибка отправки уведомлений:', error);
        // Не прерываем выполнение из-за ошибки уведомлений
    }
}

/**
 * Получить текстовое описание статуса
 */
function getStatusText(status) {
    const statusMap = {
        'assigned': 'Назначена',
        'in_progress': 'В работе',
        'completed': 'Завершена',
        'overdue': 'Просрочена',
        'rework': 'На доработке'
    };
    return statusMap[status] || status;
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
            // Подготавливаем данные пользователя для сессии
            const sessionUser = {
                id: user.id,
                login: user.login,
                name: user.name,
                email: user.email,
                role: user.role,
                auth_type: user.auth_type,
                groups: user.groups ? (typeof user.groups === 'string' ? JSON.parse(user.groups) : user.groups) : []
            };

            // Сохраняем в сессию
            req.session.user = sessionUser;
            
            // Явно сохраняем сессию
            req.session.save((err) => {
                if (err) {
                    console.error('Ошибка сохранения сессии:', err);
                    return res.status(500).json({ error: 'Ошибка сохранения сессии' });
                }

                // Логируем успешный вход
                console.log(`Успешная авторизация: ${user.name} (${user.login}) через ${user.auth_type}`);
                if (user.groups) {
                    console.log(`Группы пользователя: ${user.groups}`);
                }
                
                res.json({ 
                    success: true, 
                    user: sessionUser
                });
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
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка при выходе:', err);
            return res.status(500).json({ error: 'Ошибка при выходе' });
        }
        res.json({ success: true });
    });
});

// В server.js обновите маршрут /api/user
app.get('/api/user', (req, res) => {
    if (req.session.user) {
        // Для LDAP пользователей всегда проверяем актуальную роль
        if (req.session.user.auth_type === 'ldap') {
            db.get("SELECT groups FROM users WHERE id = ?", [req.session.user.id], (err, user) => {
                if (err || !user) {
                    req.session.destroy();
                    return res.status(401).json({ error: 'Пользователь не найден' });
                }
                
                // Парсим группы
                let groups = [];
                try {
                    groups = JSON.parse(user.groups || '[]');
                } catch (e) {
                    groups = [];
                }
                
                // Проверяем группы
                const allowedGroups = process.env.ALLOWED_GROUPS ? 
                    process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
                
                const isAdmin = groups.some(group => allowedGroups.includes(group));
                const actualRole = isAdmin ? 'admin' : 'teacher';
                
                // Обновляем роль если изменилась
                if (req.session.user.role !== actualRole) {
                    console.log(`Обновлена роль пользователя ${req.session.user.login} с ${req.session.user.role} на ${actualRole}`);
                    
                    // Обновляем в базе
                    db.run(
                        "UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?",
                        [actualRole, req.session.user.id]
                    );
                    
                    // Обновляем в сессии
                    req.session.user.role = actualRole;
                }
                
                res.json({ user: req.session.user });
            });
        } else {
            // Для локальных пользователей просто возвращаем данные
            res.json({ user: req.session.user });
        }
    } else {
        res.status(401).json({ error: 'Не аутентифицирован' });
    }
});

// ==================== МАРШРУТЫ ПОЛЬЗОВАТЕЛЕЙ ====================

app.get('/api/users', requireAuth, (req, res) => {
    const search = req.query.search || '';
    
    let query = `
        SELECT id, login, name, email, role, auth_type 
        FROM users 
        WHERE role IN ('admin', 'teacher') 
    `;
    
    const params = [];
    
    if (search) {
        query += ` AND (login LIKE ? OR name LIKE ? OR email LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern);
    }
    
    query += " ORDER BY name";
    
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// ==================== МАРШРУТЫ ЗАДАЧ ====================

// Получить задачи с учетом прав доступа и фильтров
app.get('/api/tasks', requireAuth, (req, res) => {
    const userId = req.session.user.id;
    const showDeleted = req.session.user.role === 'admin' && req.query.showDeleted === 'true';
    const search = req.query.search || '';
    const statusFilter = req.query.status || 'active,in_progress,assigned,overdue,rework';

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

    const params = [];

    // Для обычных пользователей показываем только задачи где они заказчик или исполнитель
    if (req.session.user.role !== 'admin') {
        query += ` AND (t.created_by = ? OR ta.user_id = ?)`;
        params.push(userId, userId);
    }

    if (!showDeleted) {
        query += " AND t.status = 'active'";
    }

    // Фильтр по статусу
    if (statusFilter && statusFilter !== 'all') {
        const statuses = statusFilter.split(',');
        
        if (statuses.includes('closed')) {
            if (req.session.user.role !== 'admin') {
                query += ` AND (t.closed_at IS NOT NULL AND t.created_by = ?)`;
                params.push(userId);
            } else {
                query += ` AND t.closed_at IS NOT NULL`;
            }
        } else {
            query += ` AND t.closed_at IS NULL`;
            
            if (statuses.length > 0 && !statuses.includes('all')) {
                query += ` AND EXISTS (
                    SELECT 1 FROM task_assignments ta2 
                    WHERE ta2.task_id = t.id AND ta2.status IN (${statuses.map(() => '?').join(',')})
                )`;
                statuses.forEach(status => params.push(status));
            }
        }
    } else {
        if (req.session.user.role !== 'admin') {
            query += ` AND (t.closed_at IS NULL OR t.created_by = ?)`;
            params.push(userId);
        }
    }

    // Поиск по тексту
    if (search) {
        query += ` AND (t.title LIKE ? OR t.description LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern);
    }

    query += " GROUP BY t.id ORDER BY t.created_at DESC";

    db.all(query, params, (err, tasks) => {
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

                    // Отправляем уведомления ВСЕМ участникам (создателю и исполнителям)
                    sendTaskNotifications('created', taskId, title, description, createdBy);
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

// Копировать задачу с файлами
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
                        
                        // Копируем файлы из оригинальной задачи
                        db.all("SELECT * FROM task_files WHERE task_id = ?", [taskId], (err, originalFiles) => {
                            if (!err && originalFiles && originalFiles.length > 0) {
                                originalFiles.forEach(originalFile => {
                                    const originalFilePath = originalFile.file_path;
                                    const newFilename = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(originalFile.original_name);
                                    const userFolder = createUserTaskFolder(newTaskId, req.session.user.login);
                                    const newFilePath = path.join(userFolder, newFilename);

                                    // Копируем файл
                                    if (fs.existsSync(originalFilePath)) {
                                        fs.copyFileSync(originalFilePath, newFilePath);

                                        db.run(
                                            "INSERT INTO task_files (task_id, user_id, filename, original_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)",
                                            [newTaskId, createdBy, newFilename, originalFile.original_name, newFilePath, originalFile.file_size]
                                        );

                                        logActivity(newTaskId, createdBy, 'FILE_COPIED', `Скопирован файл: ${originalFile.original_name}`);
                                    }
                                });
                            }
                        });

                        // Назначаем пользователей
                        if (assignedUsers && assignedUsers.length > 0) {
                            assignedUsers.forEach(userId => {
                                db.run(
                                    "INSERT INTO task_assignments (task_id, user_id, start_date, due_date) VALUES (?, ?, ?, ?)",
                                    [newTaskId, userId, startDate || null, dueDate || null]
                                );
                            });
                            
                            logActivity(newTaskId, createdBy, 'TASK_ASSIGNED', `Задача назначена пользователям: ${assignedUsers.join(', ')}`);

                            // Отправляем уведомления ВСЕМ участникам (создателю и исполнителям)
                            sendTaskNotifications('created', newTaskId, newTitle, originalTask.description, createdBy);
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

// Обновить задачу с проверкой прав и возможностью добавления файлов
app.put('/api/tasks/:taskId', requireAuth, upload.array('files', 15), (req, res) => {
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

                    // Обрабатываем новые файлы
                    if (req.files && req.files.length > 0) {
                        const userFolder = createUserTaskFolder(taskId, req.session.user.login);
                        
                        req.files.forEach(file => {
                            const newPath = path.join(userFolder, path.basename(file.filename));
                            fs.renameSync(file.path, newPath);

                            db.run(
                                "INSERT INTO task_files (task_id, user_id, filename, original_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)",
                                [taskId, userId, path.basename(file.filename), file.originalname, newPath, file.size]
                            );

                            logActivity(taskId, userId, 'FILE_UPLOADED', `Загружен файл: ${file.originalname}`);
                        });

                        // Очищаем временную папку
                        const tempDir = path.join(__dirname, 'data', 'uploads', 'temp');
                        if (fs.existsSync(tempDir)) {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        }
                    }

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

                            // Отправляем уведомления ВСЕМ участникам об обновлении
                            sendTaskNotifications('updated', taskId, title, description, userId);
                        });
                    } else {
                        // Если назначения не менялись, все равно отправляем уведомление ВСЕМ участникам об обновлении
                        sendTaskNotifications('updated', taskId, title, description, userId);
                    }

                    res.json({ success: true, message: 'Задача обновлена' });
                }
            );
        });
    });
});

// Вернуть задачу на доработку
app.post('/api/tasks/:taskId/rework', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const { comment } = req.body;
    const userId = req.session.user.id;

    // Проверяем права - только создатель или администратор могут возвращать на доработку
    db.get("SELECT created_by FROM tasks WHERE id = ?", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== userId) {
            return res.status(403).json({ error: 'У вас нет прав для возврата задачи на доработку' });
        }

        db.serialize(() => {
            // Обновляем задачу с комментарием
            db.run(
                "UPDATE tasks SET rework_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [comment || 'Требуется доработка', taskId],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    // Обновляем статусы всех назначений на 'rework'
                    db.run(
                        "UPDATE task_assignments SET status = 'rework', rework_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?",
                        [comment || 'Требуется доработка', taskId],
                        function(err) {
                            if (err) {
                                res.status(500).json({ error: err.message });
                                return;
                            }

                            logActivity(taskId, userId, 'TASK_SENT_FOR_REWORK', `Задача возвращена на доработку: ${comment}`);

                            // Отправляем уведомления ВСЕМ участникам о доработке
                            db.get("SELECT title, description FROM tasks WHERE id = ?", [taskId], (err, taskData) => {
                                if (!err && taskData) {
                                    sendTaskNotifications('rework', taskId, taskData.title, taskData.description, userId, comment);
                                }
                            });

                            res.json({ success: true, message: 'Задача возвращена на доработку' });
                        }
                    );
                }
            );
        });
    });
});

// Закрыть задачу
app.post('/api/tasks/:taskId/close', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    // Проверяем права - только создатель или администратор могут закрывать задачу
    db.get("SELECT created_by FROM tasks WHERE id = ?", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== userId) {
            return res.status(403).json({ error: 'У вас нет прав для закрытия этой задачи' });
        }

        db.run(
            "UPDATE tasks SET closed_at = CURRENT_TIMESTAMP, closed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [userId, taskId],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                logActivity(taskId, userId, 'TASK_CLOSED', `Задача закрыта`);

                // Отправляем уведомления ВСЕМ участникам о закрытии
                db.get("SELECT title FROM tasks WHERE id = ?", [taskId], (err, taskData) => {
                    if (!err && taskData) {
                        sendTaskNotifications('closed', taskId, taskData.title, '', userId);
                    }
                });

                res.json({ success: true, message: 'Задача закрыта' });
            }
        );
    });
});

// Открыть задачу (отменить закрытие)
app.post('/api/tasks/:taskId/reopen', requireAuth, (req, res) => {
    const { taskId } = req.params;
    const userId = req.session.user.id;

    // Проверяем права - только создатель или администратор могут открывать задачу
    db.get("SELECT created_by FROM tasks WHERE id = ?", [taskId], (err, task) => {
        if (err || !task) {
            return res.status(404).json({ error: 'Задача не найдена' });
        }

        if (req.session.user.role !== 'admin' && task.created_by !== userId) {
            return res.status(403).json({ error: 'У вас нет прав для открытия этой задачи' });
        }

        db.run(
            "UPDATE tasks SET closed_at = NULL, closed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [taskId],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                logActivity(taskId, userId, 'TASK_REOPENED', `Задача открыта`);
                res.json({ success: true, message: 'Задача открыта' });
            }
        );
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
            return res.status(403).json({ error: 'У вас нет прав для редактирования сроки' });
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

                // Отправляем уведомление ВСЕМ участникам об изменении сроков
                db.get("SELECT title, description FROM tasks WHERE id = ?", [taskId], (err, taskData) => {
                    if (!err && taskData) {
                        sendTaskNotifications('updated', taskId, taskData.title, taskData.description, currentUserId);
                    }
                });

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

        // Получаем информацию о задаче и пользователе для уведомления
        db.get(`
            SELECT t.title, t.description, u.name as user_name 
            FROM tasks t 
            LEFT JOIN users u ON u.id = ? 
            WHERE t.id = ?
        `, [currentUserId, taskId], (err, taskData) => {
            if (err) {
                console.error('Ошибка получения данных задачи:', err);
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
                    
                    // Отправляем уведомления ВСЕМ участникам об изменении статуса
                    if (taskData) {
                        sendTaskNotifications(
                            'status_changed', 
                            taskId, 
                            taskData.title, 
                            taskData.description, 
                            currentUserId,
                            '',
                            finalStatus,
                            taskData.user_name || req.session.user.name
                        );
                    }

                    res.json({ success: true, message: 'Статус обновлен' });
                }
            );
        });
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
    console.log('Система уведомлений активна');
    
    // Запускаем проверку просроченных задач каждую минуту
    setInterval(checkOverdueTasks, 60000);
});