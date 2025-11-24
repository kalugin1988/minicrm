const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Создаем папку data если нет
const dataDir = path.join(__dirname, 'data');
const createDirIfNotExists = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

createDirIfNotExists(dataDir);

// Путь к базе данных в папке data
const dbPath = path.join(dataDir, 'school_crm.db');

// Папки для загрузок и логов в data
const uploadsDir = path.join(dataDir, 'uploads');
const tasksDir = path.join(uploadsDir, 'tasks');
const logsDir = path.join(dataDir, 'logs');

createDirIfNotExists(uploadsDir);
createDirIfNotExists(tasksDir);
createDirIfNotExists(logsDir);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключение к SQLite установлено');
        console.log('База данных расположена:', dbPath);
        initializeDatabase();
    }
});

function initializeDatabase() {
    // Обновленная таблица пользователей с поддержкой LDAP
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT UNIQUE NOT NULL,
        password TEXT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'teacher',
        auth_type TEXT DEFAULT 'local',
        groups TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица задач
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        created_by INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME,
        deleted_by INTEGER,
        original_task_id INTEGER,
        start_date DATETIME,
        due_date DATETIME,
        rework_comment TEXT,
        closed_at DATETIME,
        closed_by INTEGER,
        FOREIGN KEY (created_by) REFERENCES users (id),
        FOREIGN KEY (deleted_by) REFERENCES users (id),
        FOREIGN KEY (original_task_id) REFERENCES tasks (id),
        FOREIGN KEY (closed_by) REFERENCES users (id)
    )`);

    // Таблица назначений задач
    db.run(`CREATE TABLE IF NOT EXISTS task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        status TEXT DEFAULT 'assigned',
        start_date DATETIME,
        due_date DATETIME,
        rework_comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Таблица файлов
    db.run(`CREATE TABLE IF NOT EXISTS task_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Таблица логов
    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    console.log('База данных инициализирована в папке data');
    
    // Добавляем недостающие колонки если они не существуют
    setTimeout(addMissingColumns, 1000);
}

// Функция для добавления недостающих колонок
function addMissingColumns() {
    const columnsToAdd = [
        { table: 'tasks', column: 'rework_comment', type: 'TEXT' },
        { table: 'tasks', column: 'closed_at', type: 'DATETIME' },
        { table: 'tasks', column: 'closed_by', type: 'INTEGER' },
        { table: 'task_assignments', column: 'rework_comment', type: 'TEXT' }
    ];

    columnsToAdd.forEach(({ table, column, type }) => {
        // Используем db.all вместо db.get для получения всех строк
        db.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err) {
                console.error(`Ошибка при проверке таблицы ${table}:`, err);
                return;
            }

            // rows теперь массив, можно использовать some
            const columnExists = rows.some(row => row.name === column);
            if (!columnExists) {
                db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
                    if (err) {
                        console.error(`Ошибка при добавлении колонки ${column} в таблицу ${table}:`, err);
                    } else {
                        console.log(`✅ Добавлена колонка ${column} в таблицу ${table}`);
                    }
                });
            } else {
                console.log(`✅ Колонка ${column} уже существует в таблице ${table}`);
            }
        });
    });
}

function createTaskFolder(taskId) {
    const taskFolder = path.join(tasksDir, taskId.toString());
    createDirIfNotExists(taskFolder);
    return taskFolder;
}

function createUserTaskFolder(taskId, userLogin) {
    const taskFolder = path.join(tasksDir, taskId.toString());
    const userFolder = path.join(taskFolder, userLogin);
    createDirIfNotExists(userFolder);
    return userFolder;
}

function saveTaskMetadata(taskId, title, description, createdBy, originalTaskId = null, startDate = null, dueDate = null) {
    const taskFolder = createTaskFolder(taskId);
    const metadata = {
        id: taskId,
        title: title,
        description: description,
        status: 'active',
        created_by: createdBy,
        original_task_id: originalTaskId,
        start_date: startDate,
        due_date: dueDate,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        files: []
    };

    const metadataPath = path.join(taskFolder, 'task.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

function updateTaskMetadata(taskId, updates) {
    const metadataPath = path.join(tasksDir, taskId.toString(), 'task.json');
    if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const updatedMetadata = { ...metadata, ...updates, updated_at: new Date().toISOString() };
        fs.writeFileSync(metadataPath, JSON.stringify(updatedMetadata, null, 2));
    }
}

function logActivity(taskId, userId, action, details = '') {
    db.run(
        "INSERT INTO activity_logs (task_id, user_id, action, details) VALUES (?, ?, ?, ?)",
        [taskId, userId, action, details]
    );

    const logEntry = `${new Date().toISOString()} - User ${userId}: ${action} - Task ${taskId} - ${details}\n`;
    fs.appendFileSync(path.join(logsDir, 'activity.log'), logEntry);
}

// Функция для проверки прав доступа к задаче
function checkTaskAccess(userId, taskId, callback) {
    // Сначала получаем роль пользователя
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (err) {
            callback(err, false);
            return;
        }

        // Администраторы имеют доступ ко всем задачам
        if (user && user.role === 'admin') {
            callback(null, true);
            return;
        }

        // Проверяем, не закрыта ли задача
        db.get("SELECT status, created_by, closed_at FROM tasks WHERE id = ?", [taskId], (err, task) => {
            if (err || !task) {
                callback(err, false);
                return;
            }

            // Если задача закрыта, доступ есть только у создателя и администраторов
            if (task.closed_at && task.created_by !== userId && user.role !== 'admin') {
                callback(null, false);
                return;
            }

            // Обычные пользователи видят только задачи где они заказчик или исполнитель
            const query = `
                SELECT 1 FROM tasks t
                WHERE t.id = ? AND (
                    t.created_by = ? 
                    OR EXISTS (SELECT 1 FROM task_assignments WHERE task_id = t.id AND user_id = ?)
                )
            `;

            db.get(query, [taskId, userId, userId], (err, row) => {
                callback(err, !!row);
            });
        });
    });
}

// Функция для проверки просроченных задач
function checkOverdueTasks() {
    const now = new Date().toISOString();
    
    // Временно убираем проверку на closed_at до добавления колонки
    const query = `
        SELECT ta.id, ta.task_id, ta.user_id, ta.status, ta.due_date
        FROM task_assignments ta
        JOIN tasks t ON ta.task_id = t.id
        WHERE ta.due_date IS NOT NULL 
        AND ta.due_date < ? 
        AND ta.status NOT IN ('completed', 'overdue')
        AND t.status = 'active'
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

// Запускаем проверку просроченных задач каждую минуту
setInterval(checkOverdueTasks, 60000);

module.exports = { 
    db, 
    logActivity, 
    createTaskFolder, 
    createUserTaskFolder, 
    saveTaskMetadata, 
    updateTaskMetadata,
    checkTaskAccess
};