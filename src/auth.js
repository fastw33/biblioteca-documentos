'use strict';
const jwt = require('jsonwebtoken');
function authenticate(config) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!/^Bearer \S+$/i.test(header)) return res.status(401).json({ message: 'Inicia sesión en WMS para continuar.' });
    try {
      const user = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] });
      if (!user || typeof user !== 'object' || !Number.isFinite(user.exp) ||
          !['string', 'number'].includes(typeof user.id_usuario) || !String(user.id_usuario).trim()) throw new Error('identity');
      if (user.debe_cambiar_password) return res.status(403).json({ message: 'Cambia tu contraseña en WMS antes de continuar.' });
      req.user = user;
      next();
    } catch { res.status(401).json({ message: 'La sesión no es válida o expiró. Ingresa de nuevo en WMS.' }); }
  };
}
const isAdmin = user => [true, 1, '1', 'true'].includes(user.permisos?.esAdmin);
const canEdit = (user, document) => isAdmin(user) || document.creadoPor.id === String(user.id_usuario);
function actor(user) {
  const nombre = [user.personal?.nombre, user.personal?.apellido].filter(Boolean).join(' ').trim();
  return { id: String(user.id_usuario), nombre: (nombre || user.username || String(user.id_usuario)).slice(0, 200) };
}
module.exports = { authenticate, canEdit, actor };
