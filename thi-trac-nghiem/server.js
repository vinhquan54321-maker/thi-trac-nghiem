// Server thi trắc nghiệm online - chỉ dùng module có sẵn của Node.js, không cần npm install thêm gì.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PASS = process.env.TEACHER_PASS || 'giaovien';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
if (!process.env.TEACHER_PASS) console.warn('CẢNH BÁO: chưa đặt TEACHER_PASS, đang dùng mật khẩu mặc định "giaovien".');

const sign = p => crypto.createHmac('sha256', p).update('teacher-v1').digest('hex');
const TOKEN = sign(PASS);
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

let D = { exam: { id: Date.now(), cls: '', duration: 15, questions: [], status: 'draft', startedAt: 0 }, students: {} };
try { D = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DATA, JSON.stringify(D), () => {}), 500); };

const clean = a => { const n = D.exam.questions.length; return Array.from({ length: n }, (_, i) => { const v = Array.isArray(a) ? a[i] : -1; return Number.isInteger(v) && v >= 0 && v < 4 ? v : -1; }); };
const grade = s => {
  const qs = D.exam.questions;
  s.score = qs.reduce((n, q, i) => n + (s.answers[i] === q.a ? 1 : 0), 0);
  s.total = qs.length; s.submitted = true; s.submittedAt = Date.now();
};
function tidy() {
  const e = D.exam;
  if (e.status === 'running' && Date.now() > e.startedAt + e.duration * 60000 + 15000) e.status = 'ended';
  if (e.status === 'ended') for (const s of Object.values(D.students)) if (!s.submitted) { grade(s); save(); }
}
const pub = () => { const e = D.exam; return { id: e.id, cls: e.cls, duration: e.duration, status: e.status, startedAt: e.startedAt, n: e.questions.length }; };

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 2e6) { req.destroy(); ok({}); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ok({}); } });
});
const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, post = req.method === 'POST';
  try {
    if (!p.startsWith('/api/')) {
      if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
      if (['/', '/teacher', '/teacher/', '/index.html'].includes(p)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(INDEX); }
      res.writeHead(404); return res.end('Not found');
    }
    const b = post ? await readBody(req) : {};
    const e = D.exam;

    /* ----- Học sinh ----- */
    if (p === '/api/state') {
      tidy();
      const s = D.students[u.searchParams.get('sid')];
      return send(res, 200, {
        now: Date.now(), exam: pub(),
        me: s ? { name: s.name, submitted: s.submitted, score: s.submitted ? s.score : null, total: s.total, answers: s.answers } : null,
        questions: s && !s.submitted && e.status === 'running' ? e.questions.map(({ q, o }) => ({ q, o })) : null,
      });
    }
    if (p === '/api/join' && post) {
      tidy();
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'Hãy nhập họ tên' });
      if (!e.questions.length) return send(res, 400, { error: 'Chưa có đề thi' });
      if (e.status === 'ended') return send(res, 400, { error: 'Phòng thi đã đóng' });
      if (Object.keys(D.students).length >= 1000) return send(res, 400, { error: 'Phòng thi đã đủ người' });
      const sid = crypto.randomUUID();
      D.students[sid] = { name, joinedAt: Date.now(), violations: 0, submitted: false, score: null, total: e.questions.length, answers: clean([]) };
      save(); return send(res, 200, { sid });
    }
    if (['/api/answer', '/api/submit', '/api/violation'].includes(p) && post) {
      tidy();
      const s = D.students[b.sid];
      if (!s) return send(res, 404, { error: 'Không tìm thấy thí sinh' });
      if (s.submitted) return send(res, 200, { score: s.score, total: s.total });
      if (p === '/api/violation') { if (e.status === 'running') s.violations++; }
      else if (e.status === 'running') {
        if (Array.isArray(b.answers)) s.answers = clean(b.answers);
        if (p === '/api/submit') grade(s);
      }
      save(); return send(res, 200, { score: s.score, total: s.total });
    }

    /* ----- Giáo viên ----- */
    if (p === '/api/login' && post) {
      return eq(sign(String(b.pass || '')), TOKEN) ? send(res, 200, { token: TOKEN }) : send(res, 401, { error: 'Sai mật khẩu' });
    }
    if (!eq(req.headers['x-token'] || '', TOKEN)) return send(res, 401, { error: 'Cần đăng nhập' });

    if (p === '/api/t/state') {
      tidy();
      return send(res, 200, { now: Date.now(), exam: e, students: Object.entries(D.students).map(([id, s]) => ({ id, name: s.name, joinedAt: s.joinedAt, violations: s.violations, submitted: s.submitted, score: s.score, total: s.total })) });
    }
    if (p === '/api/t/csv') {
      const rows = [['TT', 'Họ và tên', 'Đã nộp', 'Vi phạm', 'Số câu đúng', 'Tổng số câu', 'Điểm (thang 10)']];
      Object.values(D.students).sort((a, c) => a.joinedAt - c.joinedAt).forEach((s, i) =>
        rows.push([i + 1, s.name, s.submitted ? 'Có' : 'Không', s.violations, s.submitted ? s.score : '', s.total, s.submitted ? (s.score / s.total * 10).toFixed(2) : '']));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ket-qua-thi.csv"' });
      return res.end('\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
    }
    if (!post) return send(res, 404, { error: 'Không có chức năng này' });

    if (p === '/api/t/config') {
      if (e.status !== 'draft') return send(res, 400, { error: 'Không đổi cấu hình khi đang thi' });
      if (b.cls !== undefined) e.cls = String(b.cls).slice(0, 30);
      if (b.duration !== undefined) e.duration = Math.min(300, Math.max(1, parseInt(b.duration) || 15));
    } else if (p === '/api/t/import') {
      if (e.status !== 'draft') return send(res, 400, { error: 'Chỉ nạp đề khi chưa bắt đầu' });
      const ok = (Array.isArray(b.questions) ? b.questions : []).filter(x => x && typeof x.q === 'string' && Array.isArray(x.o) && x.o.length >= 2 && x.o.length <= 4 && Number.isInteger(x.a) && x.a >= 0 && x.a < x.o.length)
        .map(x => ({ q: x.q.slice(0, 1000), o: x.o.map(t => String(t).slice(0, 500)), a: x.a }));
      if (!ok.length) return send(res, 400, { error: 'Không có câu hỏi hợp lệ' });
      e.questions.push(...ok);
    } else if (p === '/api/t/clear') {
      if (e.status !== 'draft') return send(res, 400, { error: 'Chỉ xóa đề khi chưa bắt đầu' });
      e.questions = [];
    } else if (p === '/api/t/start') {
      if (e.status !== 'draft' || !e.questions.length) return send(res, 400, { error: 'Chưa thể bắt đầu' });
      e.status = 'running'; e.startedAt = Date.now();
      for (const s of Object.values(D.students)) { s.answers = clean([]); s.total = e.questions.length; }
    } else if (p === '/api/t/end') {
      e.status = 'ended'; tidy();
    } else if (p === '/api/t/reset') {
      D = { exam: { id: Date.now(), cls: e.cls, duration: e.duration, questions: [], status: 'draft', startedAt: 0 }, students: {} };
    } else return send(res, 404, { error: 'Không có chức năng này' });
    save(); send(res, 200, { ok: true });
  } catch (err) { console.error(err); send(res, 500, { error: 'Lỗi máy chủ' }); }
}).listen(PORT, () => console.log('Đang chạy tại cổng ' + PORT));
