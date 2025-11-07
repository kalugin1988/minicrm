let currentUser = null;
let users = [];
let tasks = [];

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', function() {
    checkAuth();
    setupEventListeners();
});

async function checkAuth() {
    try {
        const response = await fetch('/api/user');
        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            showMainInterface();
        } else {
            showLoginInterface();
        }
    } catch (error) {
        showLoginInterface();
    }
}

function showLoginInterface() {
    document.getElementById('login-modal').style.display = 'block';
    document.querySelector('.container').style.display = 'none';
}

function showMainInterface() {
    document.getElementById('login-modal').style.display = 'none';
    document.querySelector('.container').style.display = 'block';
    
    // Формируем информацию о пользователе
    let userInfo = `Вы вошли как: ${currentUser.name}`;
    if (currentUser.auth_type === 'ldap') {
        userInfo += ` (LDAP)`;
    }
    if (currentUser.groups && currentUser.groups.length > 0) {
        userInfo += ` | Группы: ${currentUser.groups.join(', ')}`;
    }
    
    document.getElementById('current-user').textContent = userInfo;
    
    // Показываем чекбокс удаленных задач только для администраторов
    if (currentUser.role === 'admin') {
        document.getElementById('tasks-controls').style.display = 'block';
    } else {
        document.getElementById('tasks-controls').style.display = 'none';
    }
    
    loadUsers();
    loadTasks();
    loadActivityLogs();
    showSection('tasks');
}

function setupEventListeners() {
    document.getElementById('login-form').addEventListener('submit', login);
    document.getElementById('create-task-form').addEventListener('submit', createTask);
    document.getElementById('edit-task-form').addEventListener('submit', updateTask);
    document.getElementById('copy-task-form').addEventListener('submit', copyTask);
    document.getElementById('edit-assignment-form').addEventListener('submit', updateAssignment);
    document.getElementById('files').addEventListener('change', updateFileList);
}

async function login(event) {
    event.preventDefault();
    
    const login = document.getElementById('login').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ login, password })
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            showMainInterface();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка входа');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка подключения к серверу');
    }
}

async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
        currentUser = null;
        showLoginInterface();
    } catch (error) {
        console.error('Ошибка выхода:', error);
    }
}

function showSection(sectionName) {
    document.querySelectorAll('.section').forEach(section => {
        section.classList.remove('active');
    });
    
    document.getElementById(sectionName + '-section').classList.add('active');
    
    if (sectionName === 'tasks') {
        loadTasks();
    } else if (sectionName === 'logs') {
        loadActivityLogs();
    }
}

async function loadUsers() {
    try {
        const response = await fetch('/api/users');
        users = await response.json();
        renderUsersChecklist();
        renderEditUsersChecklist();
        renderCopyUsersChecklist();
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

async function loadTasks() {
    try {
        const response = await fetch('/api/tasks');
        tasks = await response.json();
        renderTasks();
        
        // Загружаем файлы для каждой задачи
        tasks.forEach(task => {
            loadTaskFiles(task.id);
        });
    } catch (error) {
        console.error('Ошибка загрузки задач:', error);
    }
}

async function loadActivityLogs() {
    try {
        const response = await fetch('/api/activity-logs');
        const logs = await response.json();
        renderLogs(logs);
    } catch (error) {
        console.error('Ошибка загрузки логов:', error);
    }
}

function renderUsersChecklist() {
    const container = document.getElementById('users-checklist');
    container.innerHTML = users
        .filter(user => user.id !== currentUser.id)
        .map(user => `
        <div class="checkbox-item">
            <label>
                <input type="checkbox" name="assignedUsers" value="${user.id}">
                ${user.name} (${user.email})
                ${user.auth_type === 'ldap' ? '<small style="color: #666;"> - LDAP</small>' : ''}
            </label>
        </div>
    `).join('');
}

function renderEditUsersChecklist() {
    const container = document.getElementById('edit-users-checklist');
    container.innerHTML = users
        .filter(user => user.id !== currentUser.id)
        .map(user => `
        <div class="checkbox-item">
            <label>
                <input type="checkbox" name="assignedUsers" value="${user.id}">
                ${user.name} (${user.email})
                ${user.auth_type === 'ldap' ? '<small style="color: #666;"> - LDAP</small>' : ''}
            </label>
        </div>
    `).join('');
}

function renderCopyUsersChecklist() {
    const container = document.getElementById('copy-users-checklist');
    container.innerHTML = users
        .filter(user => user.id !== currentUser.id)
        .map(user => `
        <div class="checkbox-item">
            <label>
                <input type="checkbox" name="assignedUsers" value="${user.id}">
                ${user.name} (${user.email})
                ${user.auth_type === 'ldap' ? '<small style="color: #666;"> - LDAP</small>' : ''}
            </label>
        </div>
    `).join('');
}

function renderTasks() {
    const container = document.getElementById('tasks-list');
    const showDeleted = document.getElementById('show-deleted')?.checked || false;
    
    let filteredTasks = tasks;
    if (!showDeleted) {
        filteredTasks = tasks.filter(task => task.status === 'active');
    }
    
    if (filteredTasks.length === 0) {
        container.innerHTML = '<div class="loading">Задачи не найдены</div>';
        return;
    }

    container.innerHTML = filteredTasks.map(task => {
        const overallStatus = getTaskOverallStatus(task);
        const statusClass = getStatusClass(overallStatus);
        const isDeleted = task.status === 'deleted';
        const userRole = getUserRoleInTask(task);
        const canEdit = canUserEditTask(task);
        const isCopy = task.original_task_id !== null;
        
        return `
            <div class="task-card ${isDeleted ? 'deleted' : ''}">
                <div class="task-actions">
                    ${!isDeleted ? `
                        <button class="edit-btn" onclick="openEditModal(${task.id})" title="Редактировать">✏️</button>
                        <button class="copy-btn" onclick="openCopyModal(${task.id})" title="Создать копию">📋</button>
                        <button class="delete-btn" onclick="deleteTask(${task.id})" title="Удалить">🗑️</button>
                    ` : ''}
                    ${isDeleted && currentUser.role === 'admin' ? `
                        <button class="restore-btn" onclick="restoreTask(${task.id})" title="Восстановить">↶</button>
                    ` : ''}
                </div>
                
                <div class="task-header">
                    <div class="task-title">
                        ${task.title}
                        ${isDeleted ? '<span class="deleted-badge">Удалена</span>' : ''}
                        ${isCopy ? '<span class="copy-badge">Копия</span>' : ''}
                        <span class="role-badge ${getRoleBadgeClass(userRole)}">${userRole}</span>
                    </div>
                    <div class="task-status ${statusClass}">${getStatusText(overallStatus)}</div>
                </div>
                
                ${isCopy && task.original_task_title ? `
                    <div class="task-original">
                        <small>Оригинал: "${task.original_task_title}" (создал: ${task.original_creator_name})</small>
                    </div>
                ` : ''}
                
                <div class="task-description">${task.description || 'Нет описания'}</div>
                
                ${task.start_date || task.due_date ? `
                    <div class="task-dates">
                        ${task.start_date ? `<div><strong>Начать:</strong> ${formatDateTime(task.start_date)}</div>` : ''}
                        ${task.due_date ? `<div><strong>Выполнить до:</strong> ${formatDateTime(task.due_date)}</div>` : ''}
                    </div>
                ` : ''}
                
                <div class="task-assignments">
                    <strong>Исполнители:</strong>
                    ${task.assignments && task.assignments.length > 0 ? 
                        task.assignments.map(assignment => renderAssignment(assignment, task.id, canEdit)).join('') : 
                        '<div>Не назначены</div>'
                    }
                </div>
                
                <div class="file-list" id="files-${task.id}">
                    <strong>Файлы:</strong>
                    <div class="loading">Загрузка...</div>
                </div>
                
                <div class="task-meta">
                    <small>Создана: ${formatDateTime(task.created_at)} | Автор: ${task.creator_name}</small>
                    ${task.deleted_at ? `<br><small>Удалена: ${formatDateTime(task.deleted_at)}</small>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function renderAssignment(assignment, taskId, canEdit) {
    const statusClass = getStatusClass(assignment.status);
    const isCurrentUser = assignment.user_id === currentUser.id;
    const isOverdue = assignment.status === 'overdue';
    
    return `
        <div class="assignment ${isOverdue ? 'overdue' : ''}">
            <span class="assignment-status ${statusClass}"></span>
            <div style="flex: 1;">
                <strong>${assignment.user_name}</strong>
                ${isCurrentUser ? '<small>(Вы)</small>' : ''}
                ${assignment.start_date || assignment.due_date ? `
                    <div class="assignment-dates">
                        ${assignment.start_date ? `<small>Начать: ${formatDateTime(assignment.start_date)}</small>` : ''}
                        ${assignment.due_date ? `<small>Выполнить до: ${formatDateTime(assignment.due_date)}</small>` : ''}
                    </div>
                ` : ''}
            </div>
            <div class="action-buttons">
                ${isCurrentUser && assignment.status === 'assigned' ? 
                    `<button onclick="updateStatus(${taskId}, ${assignment.user_id}, 'in_progress')">Приступить</button>` : ''}
                ${isCurrentUser && (assignment.status === 'in_progress' || assignment.status === 'overdue') ? 
                    `<button onclick="updateStatus(${taskId}, ${assignment.user_id}, 'completed')">Выполнено</button>` : ''}
                ${canEdit ? 
                    `<button class="edit-date-btn" onclick="openEditAssignmentModal(${taskId}, ${assignment.user_id})" title="Редактировать сроки">📅</button>` : ''}
            </div>
        </div>
    `;
}

async function createTask(event) {
    event.preventDefault();
    
    if (!currentUser) {
        alert('Требуется аутентификация');
        return;
    }
    
    const formData = new FormData();
    formData.append('title', document.getElementById('title').value);
    formData.append('description', document.getElementById('description').value);
    
    const startDate = document.getElementById('start-date').value;
    const dueDate = document.getElementById('due-date').value;
    if (startDate) formData.append('startDate', startDate);
    if (dueDate) formData.append('dueDate', dueDate);
    
    const assignedUsers = document.querySelectorAll('#users-checklist input[name="assignedUsers"]:checked');
    assignedUsers.forEach(checkbox => {
        formData.append('assignedUsers', checkbox.value);
    });
    
    const files = document.getElementById('files').files;
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }

    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            alert('Задача успешно создана!');
            document.getElementById('create-task-form').reset();
            document.getElementById('file-list').innerHTML = '';
            loadTasks();
            loadActivityLogs();
            showSection('tasks');
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка создания задачи');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка создания задачи');
    }
}

async function openEditModal(taskId) {
    try {
        const response = await fetch(`/api/tasks/${taskId}`);
        if (!response.ok) {
            if (response.status === 404) {
                alert('Задача не найдена или у вас нет прав доступа');
            }
            throw new Error('Ошибка загрузки задачи');
        }
        
        const task = await response.json();
        
        // Дополнительная проверка прав на клиенте
        if (!canUserEditTask(task)) {
            alert('У вас нет прав для редактирования этой задачи');
            return;
        }
        
        document.getElementById('edit-task-id').value = task.id;
        document.getElementById('edit-title').value = task.title;
        document.getElementById('edit-description').value = task.description || '';
        
        // Заполняем даты
        document.getElementById('edit-start-date').value = task.start_date ? formatDateTimeForInput(task.start_date) : '';
        document.getElementById('edit-due-date').value = task.due_date ? formatDateTimeForInput(task.due_date) : '';
        
        // Отмечаем текущих исполнителей
        const checkboxes = document.querySelectorAll('#edit-users-checklist input[name="assignedUsers"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = task.assignments?.some(assignment => 
                assignment.user_id === parseInt(checkbox.value)
            ) || false;
        });
        
        document.getElementById('edit-task-modal').style.display = 'block';
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка загрузки задачи');
    }
}

function closeEditModal() {
    document.getElementById('edit-task-modal').style.display = 'none';
}

async function updateTask(event) {
    event.preventDefault();
    
    const taskId = document.getElementById('edit-task-id').value;
    const title = document.getElementById('edit-title').value;
    const description = document.getElementById('edit-description').value;
    const startDate = document.getElementById('edit-start-date').value;
    const dueDate = document.getElementById('edit-due-date').value;
    
    const assignedUsers = document.querySelectorAll('#edit-users-checklist input[name="assignedUsers"]:checked');
    const assignedUserIds = Array.from(assignedUsers).map(cb => parseInt(cb.value));
    
    try {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                title, 
                description, 
                assignedUsers: assignedUserIds,
                startDate: startDate || null,
                dueDate: dueDate || null
            })
        });

        if (response.ok) {
            alert('Задача успешно обновлена!');
            closeEditModal();
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка обновления задачи');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка обновления задачи');
    }
}

function openCopyModal(taskId) {
    document.getElementById('copy-task-id').value = taskId;
    document.getElementById('copy-task-modal').style.display = 'block';
}

function closeCopyModal() {
    document.getElementById('copy-task-modal').style.display = 'none';
}

// В функции copyTask улучшаем обработку ошибок
async function copyTask(event) {
    event.preventDefault();
    
    const taskId = document.getElementById('copy-task-id').value;
    const startDate = document.getElementById('copy-start-date').value;
    const dueDate = document.getElementById('copy-due-date').value;
    const checkboxes = document.querySelectorAll('#copy-users-checklist input[name="assignedUsers"]:checked');
    const assignedUserIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    if (assignedUserIds.length === 0) {
        alert('Выберите хотя бы одного исполнителя для копии задачи');
        return;
    }

    try {
        const response = await fetch(`/api/tasks/${taskId}/copy`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                assignedUsers: assignedUserIds,
                startDate: startDate || null,
                dueDate: dueDate || null
            })
        });

        if (response.ok) {
            alert('Копия задачи успешно создана!');
            closeCopyModal();
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка создания копии задачи');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка создания копии задачи');
    }
}

function openEditAssignmentModal(taskId, userId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const assignment = task.assignments.find(a => a.user_id === userId);
    if (!assignment) return;
    
    document.getElementById('edit-assignment-task-id').value = taskId;
    document.getElementById('edit-assignment-user-id').value = userId;
    document.getElementById('edit-assignment-start-date').value = assignment.start_date ? formatDateTimeForInput(assignment.start_date) : '';
    document.getElementById('edit-assignment-due-date').value = assignment.due_date ? formatDateTimeForInput(assignment.due_date) : '';
    
    document.getElementById('edit-assignment-modal').style.display = 'block';
}

function closeEditAssignmentModal() {
    document.getElementById('edit-assignment-modal').style.display = 'none';
}

async function updateAssignment(event) {
    event.preventDefault();
    
    const taskId = document.getElementById('edit-assignment-task-id').value;
    const userId = document.getElementById('edit-assignment-user-id').value;
    const startDate = document.getElementById('edit-assignment-start-date').value;
    const dueDate = document.getElementById('edit-assignment-due-date').value;
    
    try {
        const response = await fetch(`/api/tasks/${taskId}/assignment/${userId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                startDate: startDate || null,
                dueDate: dueDate || null
            })
        });

        if (response.ok) {
            alert('Сроки исполнителя обновлены!');
            closeEditAssignmentModal();
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка обновления сроков');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка обновления сроков');
    }
}

async function deleteTask(taskId) {
    if (!confirm('Вы уверены, что хотите удалить эту задачу?')) {
        return;
    }

    try {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            alert('Задача удалена!');
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка удаления задачи');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка удаления задачи');
    }
}

async function restoreTask(taskId) {
    try {
        const response = await fetch(`/api/tasks/${taskId}/restore`, {
            method: 'POST'
        });

        if (response.ok) {
            alert('Задача восстановлена!');
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка восстановления задачи');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка восстановления задачи');
    }
}

// В функции updateStatus улучшаем обработку ошибок
async function updateStatus(taskId, userId, status) {
    try {
        const response = await fetch(`/api/tasks/${taskId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ userId, status })
        });

        if (response.ok) {
            loadTasks();
            loadActivityLogs();
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка обновления статуса');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка обновления статуса');
    }
}

function getTaskOverallStatus(task) {
    if (task.status === 'deleted') return 'deleted';
    if (!task.assignments || task.assignments.length === 0) return 'unassigned';

    const assignments = task.assignments;
    let hasAssigned = false;
    let hasInProgress = false;
    let hasOverdue = false;
    let allCompleted = true;

    for (let assignment of assignments) {
        if (assignment.status === 'assigned') {
            hasAssigned = true;
            allCompleted = false;
        } else if (assignment.status === 'in_progress') {
            hasInProgress = true;
            allCompleted = false;
        } else if (assignment.status === 'overdue') {
            hasOverdue = true;
            allCompleted = false;
        } else if (assignment.status !== 'completed') {
            allCompleted = false;
        }
    }

    if (allCompleted) return 'completed';
    if (hasOverdue) return 'overdue';
    if (hasInProgress) return 'in_progress';
    if (hasAssigned) return 'assigned';
    return 'unassigned';
}

function getStatusClass(status) {
    switch (status) {
        case 'deleted': return 'status-gray';
        case 'unassigned': return 'status-purple';
        case 'assigned': return 'status-red';
        case 'in_progress': return 'status-orange';
        case 'overdue': return 'status-darkred';
        case 'completed': return 'status-green';
        default: return 'status-purple';
    }
}

function getStatusText(status) {
    switch (status) {
        case 'deleted': return 'Удалена';
        case 'unassigned': return 'Не назначена';
        case 'assigned': return 'Назначена';
        case 'in_progress': return 'В работе';
        case 'overdue': return 'Просрочена';
        case 'completed': return 'Выполнена';
        default: return 'Неизвестно';
    }
}

function getUserRoleInTask(task) {
    if (!currentUser) return 'Нет доступа';
    
    if (currentUser.role === 'admin') return 'Администратор';
    if (parseInt(task.created_by) === currentUser.id) return 'Заказчик';
    
    // Проверяем является ли пользователь исполнителем
    if (task.assignments) {
        const isExecutor = task.assignments.some(assignment => 
            parseInt(assignment.user_id) === currentUser.id
        );
        if (isExecutor) return 'Исполнитель';
    }
    
    return 'Наблюдатель';
}

function getRoleBadgeClass(role) {
    switch (role) {
        case 'Администратор': return 'role-admin';
        case 'Заказчик': return 'role-creator';
        case 'Исполнитель': return 'role-executor';
        default: return '';
    }
}

function canUserEditTask(task) {
    if (!currentUser) return false;
    
    if (currentUser.role === 'admin') return true; // Администратор
    if (parseInt(task.created_by) === currentUser.id) return true; // Заказчик
    
    return false;
}

function formatDateTime(dateTimeString) {
    if (!dateTimeString) return '';
    const date = new Date(dateTimeString);
    return date.toLocaleString('ru-RU');
}

function formatDateTimeForInput(dateTimeString) {
    if (!dateTimeString) return '';
    const date = new Date(dateTimeString);
    return date.toISOString().slice(0, 16);
}

function updateFileList() {
    const fileInput = document.getElementById('files');
    const fileList = document.getElementById('file-list');
    const files = fileInput.files;
    
    if (files.length === 0) {
        fileList.innerHTML = '';
        return;
    }
    
    let html = '<ul>';
    let totalSize = 0;
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        totalSize += file.size;
        html += `<li>${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)</li>`;
    }
    
    html += '</ul>';
    html += `<p><strong>Общий размер: ${(totalSize / 1024 / 1024).toFixed(2)} MB / 300 MB</strong></p>`;
    
    fileList.innerHTML = html;
}

function renderLogs(logs) {
    const container = document.getElementById('logs-list');
    
    if (logs.length === 0) {
        container.innerHTML = '<div class="loading">Логи не найдены</div>';
        return;
    }

    container.innerHTML = logs.map(log => `
        <div class="log-entry">
            <div class="log-time">${formatDateTime(log.created_at)}</div>
            <div><strong>${log.user_name}</strong> - ${getActionText(log.action)}</div>
            <div>Задача: "${log.task_title}"</div>
            ${log.details ? `<div>Детали: ${log.details}</div>` : ''}
        </div>
    `).join('');
}

function getActionText(action) {
    const actions = {
        'TASK_CREATED': 'создал задачу',
        'TASK_COPIED': 'создал копию задачи',
        'TASK_UPDATED': 'обновил задачу',
        'TASK_DELETED': 'удалил задачу',
        'TASK_RESTORED': 'восстановил задачу',
        'TASK_ASSIGNED': 'назначил задачу',
        'TASK_ASSIGNMENTS_UPDATED': 'обновил назначения',
        'ASSIGNMENT_UPDATED': 'обновил сроки исполнителя',
        'STATUS_CHANGED': 'изменил статус задачи',
        'FILE_UPLOADED': 'загрузил файл'
    };
    
    return actions[action] || action;
}

async function loadTaskFiles(taskId) {
    try {
        const response = await fetch(`/api/tasks/${taskId}/files`);
        const files = await response.json();
        
        const container = document.getElementById(`files-${taskId}`);
        if (container) {
            if (files.length === 0) {
                container.innerHTML = '<strong>Файлы:</strong> Нет файлов';
            } else {
                container.innerHTML = `
                    <strong>Файлы:</strong>
                    ${files.map(file => `
                        <div class="file-item">
                            <a href="/api/files/${file.id}/download" download="${file.original_name}">
                                ${file.original_name}
                            </a>
                            (${(file.file_size / 1024 / 1024).toFixed(2)} MB)
                            <small> - загрузил: ${file.user_name}</small>
                        </div>
                    `).join('')}
                `;
            }
        }
    } catch (error) {
        console.error('Ошибка загрузки файлов:', error);
    }
}