function assess(expr, has) {
    if ('course_code' in expr)
        return has(expr.course_code.replace(/\s+/g, '').toUpperCase());
    if ('text' in expr)
        return null;
    const all = 'all_of' in expr;
    const values = (all ? expr.all_of : expr.any_of).map(child => assess(child, has));
    const decisive = !all;
    return values.includes(decisive) ? decisive : values.includes(null) ? null : all;
}
export function checkRequirements(raw, history, selected) {
    const blocked = [], pending = [];
    const passed = (code) => history?.has(code) ?? null;
    const concurrent = (code) => selected.has(code) || passed(code);
    if (raw.parse_status === 'unavailable')
        pending.push('缺少注册要求数据');
    if (raw.parse_status === 'partial')
        pending.push(raw.raw_text || '部分注册要求待核实');
    for (const [key, label] of [['prerequisite', '先修'], ['corequisite', '同修'], ['exclusion', '排除']]) {
        const expr = raw[key];
        if (!expr)
            continue;
        const result = assess(expr, key === 'prerequisite' ? passed : concurrent);
        const message = label + ' · ' + (raw.raw_text || '请查看课程目录');
        if (result === null && raw.parse_status !== 'partial')
            pending.push(message);
        else if (result !== null && result === (key === 'exclusion'))
            blocked.push(message);
    }
    return { blocked, pending };
}
