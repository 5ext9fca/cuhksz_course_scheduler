import { tutorialOptions } from './pairing.js';
export const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export const minute = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function dayNumber(str) { const [y, m, d] = str.split(/[-/]/).map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
function readMeeting(m) {
    const raw = String(m.days_and_times || '').trim();
    const t = raw.match(/^(.+?)\s*(\d{1,2}:[0-5]\d)\s*[-–—]\s*(\d{1,2}:[0-5]\d)$/);
    if (!t)
        return [];
    const dayPattern = /(?:星期|周|週)([一二三四五六日天])/g;
    const dayList = Array.from(t[1].matchAll(dayPattern), a => weekdays.indexOf(a[1] === '天' ? '日' : a[1]));
    if (!dayList.length || t[1].replace(dayPattern, '').replace(/[\s,，、]/g, ''))
        return [];
    const start = minute(t[2]), end = minute(t[3]);
    if (end <= start || end > 1440)
        return [];
    const dates = String(m.date_range || '').match(/^(\d{4}[/-]\d{1,2}[/-]\d{1,2})\s*[-–—]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})$/);
    const first = dates ? dayNumber(dates[1]) : -Infinity, last = dates ? dayNumber(dates[2]) : Infinity;
    return [...new Set(dayList)].map(day => ({ day, start, end, first, last }));
}
function requireCurrentSchema(value) {
    if (value?.schema_version !== 2)
        throw Error('需要 schema_version: 2，请用当前 scraper 重新导出或刷新 SIS。');
}
export function parseCatalog(value) {
    requireCurrentSchema(value);
    const data = value;
    const rows = data.offerings?.map(o => ({ ...o.course, sections: o.sections, plan_matches: o.plan_matches }));
    function component(s) {
        if (s.kind === 'lecture')
            return 'LEC';
        if (s.kind === 'tutorial')
            return 'TUT';
        if (s.kind === 'other' && s.component)
            return s.component;
        throw Error('教学班缺少有效的 kind 或 component');
    }
    if (!data || !Array.isArray(rows) || !data.term)
        throw Error('请选择 sis-catalog 导出的学期开课目录 JSON。');
    const courses = [], sections = new Map(), seen = new Set();
    for (const row of rows) {
        if (typeof row?.course_code !== 'string' || !row.course_code.trim() || typeof row.title !== 'string' || !Array.isArray(row.sections))
            throw Error('课程缺少课号、名称或教学班列表。');
        const code = row.course_code.trim();
        if (seen.has(code))
            throw Error('重复课号 ' + code);
        seen.add(code);
        if (!['parsed', 'partial', 'empty', 'unavailable'].includes(row.enrollment_requirements?.parse_status))
            throw Error(code + ' 注册要求结构无效，请重新导出。');
        const course = { requirements: row.enrollment_requirements, code, title: row.title, subject: code.match(/^[a-z]+/i)?.[0] || code, groups: new Map(), teachers: [], evidence: row.plan_matches || data.study_plan?.course_evidence?.[courseKey(code)] || [] };
        if (!Array.isArray(course.evidence) || course.evidence.some(e => !e || typeof e.requirement !== 'string' || (e.path != null && !Array.isArray(e.path))))
            throw Error(code + ' 的修读计划依据无效。');
        const tutorials = new Set(row.sections.filter(s => component(s) === 'TUT').map(s => String(s.class_number)));
        for (const s of row.sections) {
            if (!s?.class_number || typeof s.section !== 'string' || !s.section.trim() || !Array.isArray(s.meetings))
                throw Error(code + ' 的教学班数据不完整。');
            const id = String(s.class_number);
            if (sections.has(id))
                throw Error('重复班号 ' + id);
            const type = component(s);
            const slots = [];
            let unknown = !s.meetings.length;
            for (const m of s.meetings) {
                if (!m || typeof m !== 'object')
                    throw Error(code + ' 的上课时段无效。');
                const parsed = readMeeting(m);
                if (!parsed.length)
                    unknown = true;
                slots.push(...parsed);
                if (m.instructor)
                    course.teachers.push(String(m.instructor));
            }
            let options = null;
            if (type === 'LEC') {
                const choice = s.tutorial_selection;
                if (choice?.status === 'unknown')
                    options = null;
                else if (choice?.status === 'known' && Array.isArray(choice.class_numbers)
                    && choice.max_select === Number(choice.class_numbers.length > 0)
                    && (choice.min_select === 0 || choice.min_select === 1 && choice.max_select === 1)) {
                    options = { required: choice.min_select === 1, class_numbers: choice.class_numbers };
                }
                else
                    throw Error('无效的辅导班选择范围：' + id);
            }
            const rule = type === 'LEC' ? tutorialOptions(options, tutorials, id) : null;
            const rec = { id, code, type, rule, section: s.section, status: String(s.status || ''), session: String(s.session || ''), meetings: s.meetings, slots, unknown };
            sections.set(id, rec);
            if (!course.groups.has(type))
                course.groups.set(type, []);
            course.groups.get(type).push(rec);
        }
        courses.push(course);
    }
    return { term: String(data.term), label: String(data.term_label || data.term), major: [data.study_plan?.major, data.study_plan?.stream].filter(Boolean).join(' / '), courses, sections, byCode: new Map(courses.map(c => [c.code, c])) };
}
export const courseKey = (code) => code.replace(/\s+/g, '').toUpperCase();
export function parseHistory(value) {
    requireCurrentSchema(value);
    const data = value;
    if (!Array.isArray(data?.terms))
        throw Error('请选择 sis-export 导出的修读记录（completed.json）。');
    const passed = new Map();
    for (const term of data.terms) {
        if (!Array.isArray(term?.courses))
            throw Error('修读记录缺少学期课程列表。');
        for (const row of term.courses) {
            if (typeof row?.course_code !== 'string' || !row.course_code.trim() || typeof row.status !== 'string' || !('grade' in row))
                throw Error('修读记录缺少课号、状态或成绩。');
            const status = row.status.trim(), grade = String(row.grade ?? '').trim();
            if (!/^(已注册|已註冊|已完成|enrolled|completed)$/i.test(status))
                continue;
            if (!/^(?:[ABC][+-]?|D[+-]?|P|PA|PASS|DI|DISTINCTION)$/i.test(grade))
                continue;
            passed.set(courseKey(row.course_code), [row.course_code.trim(), row.title || ''].join(' · '));
        }
    }
    return passed;
}
