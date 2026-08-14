const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add a Railway PostgreSQL service and connect it to this app.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE === 'true' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const PASS_ITER_DEFAULT = 150000;
const PHASE2_KEYS = ['company','users','vehicles','vehicleExpenses','showroomExpenses','sales','credits','complaints','deposits','partners','investors','todo','audit','deleted','purchaseInvoices'];
const locks = new Map();
const presence = new Map();
const activity = [];
const LOCK_TTL_MS = 5 * 60 * 1000;
const PRESENCE_TTL_MS = 20 * 1000;

const defaultPerms = () => {
  const tabs = {};
  ['Dashboard','Vehicles','Sales','Deposits','Sold','Complaints','Expenses','Showroom','To-Do'].forEach(k => tabs[k] = true);
  return { tabs };
};

function defaultDb() {
  return {
    _sync: { version: 1, loadedVersion: 1, updatedAt: new Date().toISOString(), clientId: 'railway', sourceOfTruth: 'server' },
    users: [{ id:'u1', username:'admin', password:'admin', role:'admin', perms:defaultPerms() }],
    company: { name:'Star Cars London Ltd', address:'Park Farm, Sewardstone Road, London E4 7RG', phone:'', email:'', vatNumber:'', companyNumber:'', terms:'All vehicles supplied under CRA 2015. See full T&Cs.', logo:'', dvlaProxy:'', dvlaKey:'', dvsaKey:'', dvsaProxy:'', gistId:'', openingBank:0, openingCash:0, invoiceFontPx:12, logoMaxW:140, logoMaxH:80 },
    vehicles: [], vehicleExpenses: [], showroomExpenses: [], sales: [], credits: [], complaints: [], deposits: [],
    partners: [{id:'p1',name:'Director A',balance:0,tx:[]},{id:'p2',name:'Director B',balance:0,tx:[]}],
    investors: [], audit: [], todo: [], purchaseInvoices: [], deleted: {}
  };
}

function clone(v) { return JSON.parse(JSON.stringify(v ?? {})); }
function now() { return new Date().toISOString(); }
function ensureSyncMeta(db) {
  db = db && typeof db === 'object' ? db : {};
  db._sync = db._sync || {};
  if (db._sync.version == null) db._sync.version = 0;
  if (!db._sync.updatedAt) db._sync.updatedAt = now();
  if (!db._sync.sourceOfTruth) db._sync.sourceOfTruth = 'server';
  return db;
}
function sanitizeUser(u) {
  const x = clone(u || {});
  delete x.password;
  delete x.passHash;
  delete x.passSalt;
  delete x.passIter;
  return x;
}
function publicDb(db) {
  const out = clone(db);
  out.users = Array.isArray(out.users) ? out.users.map(sanitizeUser) : [];
  return out;
}
function hashPassword(password, saltB64, iterations = PASS_ITER_DEFAULT) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, 'sha256').toString('base64');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const passIter = PASS_ITER_DEFAULT;
  return { passSalt:salt, passIter, passHash:hashPassword(password, salt, passIter), password:String(password) };
}
function verifyPassword(user, password) {
  if (!user) return false;
  if (user.passHash && user.passSalt) {
    const got = hashPassword(password, user.passSalt, user.passIter || PASS_ITER_DEFAULT);
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(user.passHash));
  }
  return typeof user.password === 'string' && user.password === String(password);
}
function sanitizeDb(db) {
  db = ensureSyncMeta(clone(db));
  db.users = Array.isArray(db.users) ? db.users : [];
  return db;
}

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS starcars_db (id INTEGER PRIMARY KEY, data JSONB NOT NULL, version BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const r = await pool.query('SELECT id FROM starcars_db WHERE id=1');
  if (!r.rowCount) {
    const db = defaultDb();
    await pool.query('INSERT INTO starcars_db(id,data,version,updated_at) VALUES(1,$1,$2,NOW())', [JSON.stringify(db), 1]);
    console.log('Initialized Star Cars database. Default first login: admin / admin. Change it immediately.');
  }
}
async function getRow(client = pool) {
  const r = await client.query('SELECT data, version, updated_at FROM starcars_db WHERE id=1');
  if (!r.rowCount) throw new Error('Database is not initialized');
  const db = sanitizeDb(r.rows[0].data);
  db._sync = db._sync || {};
  db._sync.version = Number(r.rows[0].version);
  db._sync.loadedVersion = Number(r.rows[0].version);
  db._sync.updatedAt = r.rows[0].updated_at?.toISOString?.() || String(r.rows[0].updated_at);
  db._sync.sourceOfTruth = 'server';
  return { db, version:Number(r.rows[0].version) };
}
async function saveDb(db, expectedVersion = null, client = pool) {
  const clean = sanitizeDb(db);
  const current = await getRow(client);
  if (expectedVersion != null && Number(expectedVersion) !== current.version) {
    const err = new Error('Database version conflict'); err.code='CONFLICT'; err.latest=current.db; err.version=current.version; throw err;
  }
  const nextVersion = current.version + 1;
  clean._sync = clean._sync || {};
  clean._sync.version = nextVersion;
  clean._sync.loadedVersion = nextVersion;
  clean._sync.updatedAt = now();
  clean._sync.sourceOfTruth = 'server';
  const upd = await client.query('UPDATE starcars_db SET data=$1, version=$2, updated_at=NOW() WHERE id=1 AND version=$3', [JSON.stringify(clean), nextVersion, current.version]);
  if (upd.rowCount !== 1) {
    const latest = await getRow(client);
    const err = new Error('Database version conflict'); err.code='CONFLICT'; err.latest=latest.db; err.version=latest.version; throw err;
  }
  return { db:clean, version:nextVersion };
}
async function transactionSave(mutator, expectedVersion = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await getRow(client);
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      const err = new Error('Database version conflict'); err.code='CONFLICT'; err.latest=current.db; err.version=current.version; throw err;
    }
    const next = await mutator(clone(current.db), current.version);
    const saved = await saveDb(next, current.version, client);
    await client.query('COMMIT');
    return saved;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} ; throw e; }
  finally { client.release(); }
}
function expectedVersion(req) { return req.get('If-Match') || req.body?._sync?.loadedVersion || null; }
function jsonError(res, status, error, extra={}) { return res.status(status).json({ok:false,error,...extra}); }

app.get('/health', async (_req,res) => {
  try { await pool.query('SELECT 1'); res.json({ok:true, service:'starcars', time:now()}); }
  catch(e) { res.status(503).json({ok:false,error:e.message}); }
});
app.get('/api/meta', async (_req,res) => { try { const r=await getRow(); res.json({ok:true,version:r.version,updatedAt:r.db._sync.updatedAt}); } catch(e){jsonError(res,500,e.message);} });
app.get('/api/db', async (_req,res) => { try { const r=await getRow(); res.json(publicDb(r.db)); } catch(e){jsonError(res,500,e.message);} });

app.post('/api/login', async (req,res) => {
  try {
    const username=String(req.body.username||'').trim(); const password=String(req.body.password||'');
    const r=await getRow(); const user=(r.db.users||[]).find(u=>String(u.username||'').trim().toLowerCase()===username.toLowerCase());
    if(!verifyPassword(user,password)) return jsonError(res,401,'Invalid username or password');
    const safe=sanitizeUser(user); activity.unshift({ts:now(),action:'login',username:user.username,userId:user.id||'',entity:'',clientId:req.body.clientId||''}); activity.splice(200);
    res.json({ok:true,user:safe,db:publicDb(r.db)});
  } catch(e){jsonError(res,500,e.message);} 
});

app.post('/api/db', async (req,res) => {
  try { const saved=await saveDb(req.body, expectedVersion(req)); res.json({ok:true,db:publicDb(saved.db)}); }
  catch(e){ if(e.code==='CONFLICT') return jsonError(res,409,e.message,{latest:publicDb(e.latest),version:e.version}); jsonError(res,500,e.message); }
});
app.post('/api/db/sections', async (req,res) => {
  try {
    const sections=req.body.sections||{}; const expected=req.get('If-Match');
    const saved=await transactionSave((db)=>{ for(const k of Object.keys(sections)){ if(PHASE2_KEYS.includes(k)) db[k]=clone(sections[k]); } db._sync=Object.assign({},db._sync,req.body._sync||{}); return db; }, expected);
    res.json({ok:true,db:publicDb(saved.db)});
  } catch(e){ if(e.code==='CONFLICT') return jsonError(res,409,e.message,{latest:publicDb(e.latest),version:e.version}); jsonError(res,500,e.message); }
});
app.post('/api/db/restore-full', async (req,res) => {
  try { const incoming=sanitizeDb(req.body.db||{}); const saved=await saveDb(incoming, null); res.json({ok:true,db:publicDb(saved.db)}); }
  catch(e){jsonError(res,500,e.message);} 
});
app.post('/api/users/save', async (req,res) => {
  try {
    const users=Array.isArray(req.body.users)?req.body.users:[];
    const saved=await transactionSave(db=>{ if(req.body.replace!==false) db.users=clone(users); return db; });
    res.json({ok:true,db:publicDb(saved.db)});
  } catch(e){jsonError(res,500,e.message);} 
});
app.get('/api/users/status', async (_req,res)=>{try{const r=await getRow();res.json({ok:true,users:(r.db.users||[]).map(u=>({id:u.id,username:u.username,role:u.role,hasHash:!!(u.passHash&&u.passSalt)}))});}catch(e){jsonError(res,500,e.message);}});
app.post('/api/change-password', async (req,res)=>{
  try {
    const username=String(req.body.username||'').trim(), current=String(req.body.currentPassword||''), next=String(req.body.newPassword||'');
    if(!next) return jsonError(res,400,'Password cannot be empty');
    const saved=await transactionSave(db=>{const u=(db.users||[]).find(x=>String(x.username||'').trim().toLowerCase()===username.toLowerCase()); if(!verifyPassword(u,current)){const e=new Error('Current password is incorrect');e.http=401;throw e;} Object.assign(u,makePassword(next),{passwordUpdatedAt:now(),_updatedAt:now(),updatedAt:now()}); return db;});
    res.json({ok:true,db:publicDb(saved.db)});
  } catch(e){jsonError(res,e.http||500,e.message);} 
});
app.post('/api/security/disable-default-admin', (_req,res)=>res.json({ok:true}));

app.post('/api/activity',(req,res)=>{activity.unshift({...clone(req.body),ts:now()});activity.splice(200);res.json({ok:true});});
app.get('/api/activity',(_req,res)=>res.json({ok:true,activity:activity.slice(0,100)}));

function lockKey(type,id){return `${type}:${id}`;}
app.post('/api/locks',(req,res)=>{const type=String(req.body.type||''),id=String(req.body.id||'');if(!type||!id)return jsonError(res,400,'type and id required');const key=lockKey(type,id);const existing=locks.get(key);const nowMs=Date.now();if(existing&&existing.expires>nowMs&&existing.clientId!==req.body.clientId){return res.status(409).json({ok:false,error:'Locked',lock:existing});}const lock={type,id,userId:req.body.userId||'',username:req.body.username||'',clientId:req.body.clientId||'',expires:nowMs+LOCK_TTL_MS,ts:now()};locks.set(key,lock);res.json({ok:true,lock});});
app.delete('/api/locks/:type/:id',(req,res)=>{const key=lockKey(req.params.type,req.params.id);const x=locks.get(key);if(!x||!req.query.userId||x.userId===req.query.userId)locks.delete(key);res.json({ok:true});});
app.get('/api/presence',(_req,res)=>{const t=Date.now();for(const [k,v] of presence)if(v.expires<t)presence.delete(k);const ls=[];for(const [key,v] of locks)if(v.expires<t)locks.delete(key);else ls.push(v);res.json({ok:true,presence:[...presence.values()],locks:ls});});
app.post('/api/presence',(req,res)=>{const key=String(req.body.clientId||req.ip);presence.set(key,{...clone(req.body),ts:now(),expires:Date.now()+PRESENCE_TTL_MS});res.json({ok:true});});

app.use(express.static(path.join(__dirname,'public'),{etag:true,maxAge:'1h'}));
app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({ok:false,error:'API route not found'});res.sendFile(path.join(__dirname,'public','index.html'));});

init().then(()=>app.listen(PORT,()=>console.log(`Star Cars Railway app listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
