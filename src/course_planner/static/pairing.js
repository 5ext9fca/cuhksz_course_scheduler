export function tutorialOptions(raw, tutorialIds, lecture) {
    if (raw == null)
        return null;
    const data = raw;
    if (typeof data.required !== 'boolean' || !Array.isArray(data.class_numbers) ||
        data.class_numbers.some(n => typeof n !== 'string' || !tutorialIds.has(n))) {
        throw Error('讲课班 ' + lecture + ' 的 tutorial_options 无效或引用了其他课程的班号。');
    }
    return { required: data.required, class_numbers: [...new Set(data.class_numbers)] };
}
export function acceptsTutorial(rule, id) {
    if (rule == null)
        return id !== null; // Legacy catalogs require one TUT whenever the course lists tutorials.
    return id === null ? !rule.required : rule.class_numbers.includes(id);
}
