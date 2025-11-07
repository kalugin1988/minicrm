const bcrypt = require('bcryptjs');
const { db } = require('./database');
const fetch = require('node-fetch');

class AuthService {
    constructor() {
        this.initUsers();
    }

    async initUsers() {
        // Создаем пользователей из .env
        const users = [
            {
                login: process.env.USER_1_LOGIN,
                password: process.env.USER_1_PASSWORD,
                name: process.env.USER_1_NAME,
                email: process.env.USER_1_EMAIL,
                auth_type: 'local'
            },
            {
                login: process.env.USER_2_LOGIN,
                password: process.env.USER_2_PASSWORD,
                name: process.env.USER_2_NAME,
                email: process.env.USER_2_EMAIL,
                auth_type: 'local'
            },
            {
                login: process.env.USER_3_LOGIN,
                password: process.env.USER_3_PASSWORD,
                name: process.env.USER_3_NAME,
                email: process.env.USER_3_EMAIL,
                auth_type: 'local'
            }
        ];

        for (const userData of users) {
            if (userData.login && userData.password) {
                await this.createUserIfNotExists(userData);
            }
        }
    }

    async createUserIfNotExists(userData) {
        return new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE login = ?", [userData.login], async (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (!row) {
                    const hashedPassword = await bcrypt.hash(userData.password, 10);
                    db.run(
                        "INSERT INTO users (login, password, name, email, role, auth_type, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
                        [
                            userData.login, 
                            hashedPassword, 
                            userData.name, 
                            userData.email, 
                            'teacher', 
                            userData.auth_type || 'local'
                        ],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                console.log(`Создан пользователь: ${userData.name}`);
                                resolve(this.lastID);
                            }
                        }
                    );
                } else {
                    resolve(row.id);
                }
            });
        });
    }

    async authenticateLocal(login, password) {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE login = ? AND auth_type = 'local'", [login], async (err, user) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (!user) {
                    resolve(null);
                    return;
                }

                const isValid = await bcrypt.compare(password, user.password);
                if (isValid) {
                    // Не возвращаем пароль
                    const { password, ...userWithoutPassword } = user;
                    resolve(userWithoutPassword);
                } else {
                    resolve(null);
                }
            });
        });
    }

    async authenticateLDAP(username, password) {
        try {
            const response = await fetch(process.env.LDAP_AUTH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.success) {
                return this.processLDAPUser(data);
            } else {
                return null;
            }
        } catch (error) {
            console.error('LDAP authentication error:', error);
            return null;
        }
    }

    async processLDAPUser(ldapData) {
        const { username, full_name, groups, description } = ldapData;
        
        // Определяем роль пользователя на основе групп
        const allowedGroups = process.env.ALLOWED_GROUPS ? 
            process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
        
        const isAdmin = groups.some(group => 
            allowedGroups.includes(group)
        );
        
        const role = isAdmin ? 'admin' : 'teacher';
        
        // Сохраняем/обновляем пользователя в базе
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE login = ? AND auth_type = 'ldap'", [username], async (err, existingUser) => {
                if (err) {
                    reject(err);
                    return;
                }

                const userData = {
                    login: username,
                    name: full_name,
                    email: `${username}@school25.ru`,
                    role: role,
                    auth_type: 'ldap',
                    groups: JSON.stringify(groups),
                    description: description || '',
                    last_login: new Date().toISOString()
                };

                if (existingUser) {
                    // Обновляем существующего пользователя
                    db.run(
                        `UPDATE users SET 
                         name = ?, email = ?, role = ?, groups = ?, description = ?, last_login = datetime('now')
                         WHERE id = ?`,
                        [userData.name, userData.email, userData.role, userData.groups, userData.description, existingUser.id],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({ ...existingUser, ...userData });
                            }
                        }
                    );
                } else {
                    // Создаем нового пользователя
                    db.run(
                        `INSERT INTO users (login, name, email, role, auth_type, groups, description, created_at, last_login) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                        [userData.login, userData.name, userData.email, userData.role, userData.auth_type, 
                         userData.groups, userData.description],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({
                                    id: this.lastID,
                                    ...userData
                                });
                            }
                        }
                    );
                }
            });
        });
    }

    async authenticate(login, password) {
        // Сначала пробуем локальную авторизацию
        const localUser = await this.authenticateLocal(login, password);
        if (localUser) {
            return localUser;
        }

        // Если локальная не сработала, пробуем LDAP
        const ldapUser = await this.authenticateLDAP(login, password);
        if (ldapUser) {
            return ldapUser;
        }

        return null;
    }

    getUserById(id) {
        return new Promise((resolve, reject) => {
            db.get("SELECT id, login, name, email, role, auth_type, groups, description FROM users WHERE id = ?", [id], (err, user) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(user);
                }
            });
        });
    }
}

module.exports = new AuthService();