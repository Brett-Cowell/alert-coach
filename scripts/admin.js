'use strict';
// Owner tools. Usage:
//   node --no-warnings scripts/admin.js list
//   node --no-warnings scripts/admin.js extend <tenantId> <days>
//   node --no-warnings scripts/admin.js seats <tenantId> <n>
const { q } = require('../db');
const [cmd, id, n] = process.argv.slice(2);
const day = 864e5;
if (cmd === 'list') {
  for (const t of q.all('SELECT * FROM tenants ORDER BY created_at')) {
    const users = q.one('SELECT COUNT(*) n FROM users WHERE tenant_id=?', t.id).n;
    const left = Math.ceil((t.trial_ends_at - Date.now()) / day);
    console.log(`${t.id}  ${t.name}  users ${users}/${t.seats}  ${t.sub_status ? 'sub:' + t.sub_status : 'trial ' + (left > 0 ? left + 'd left' : 'ended')}`);
  }
} else if (cmd === 'extend' && id && +n > 0) {
  q.run('UPDATE tenants SET trial_ends_at=? WHERE id=?', Date.now() + n * day, id); console.log('Trial now ends in ' + n + ' days.');
} else if (cmd === 'seats' && id && +n > 0) {
  q.run('UPDATE tenants SET seats=? WHERE id=?', Math.round(+n), id); console.log('Seats set to ' + Math.round(+n) + '.');
} else { console.log('Commands: list | extend <tenantId> <days> | seats <tenantId> <n>'); process.exit(1); }
