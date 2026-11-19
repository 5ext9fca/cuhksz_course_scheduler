async function api(path, method = 'GET', body) {
    const response = await fetch('/api/' + path, {
        method, cache: 'no-store',
        headers: method === 'POST' ? { 'X-Planner-Request': '1', 'Content-Type': 'application/json' } : {},
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const detail = Array.isArray(error.detail) ? error.detail.map((d) => d.msg).join('；') : error.detail;
        throw Error(detail || '本地服务返回 ' + response.status);
    }
    return response.json();
}
function node(id) { return document.getElementById(id); }
export function connectSync(apply) {
    const form = node('syncForm'), scope = node('syncScope');
    const submit = node('syncStart'), cancel = node('syncCancel');
    const status = node('syncStatus'), progress = node('syncProgress');
    const field = (name) => form.elements.namedItem(name);
    let active = null, loaded = null, sequence = 0, timer = 0;
    const errorText = (error) => error instanceof Error ? error.message : String(error);
    const busy = (job) => job?.status === 'running' || job?.status === 'cancelling';
    function controls(job) {
        active = job;
        const running = busy(job);
        submit.disabled = running;
        for (const item of Array.from(form.querySelectorAll('input,select')))
            item.disabled = running;
        cancel.hidden = !running;
        cancel.disabled = job?.status === 'cancelling';
        progress.hidden = !running;
        if (job?.total && job.phase === 'catalog') {
            progress.max = job.total;
            progress.value = job.completed;
        }
        else
            progress.removeAttribute('value');
    }
    async function poll() {
        clearTimeout(timer);
        const mine = ++sequence;
        try {
            const state = await api('state');
            if (mine !== sequence)
                return;
            controls(state.job);
            const job = state.job;
            status.textContent = job ? job.term + ' · ' + job.message + (job.total && job.phase === 'catalog' ? '（' + job.completed + '/' + job.total + ' 学科已完成）' : '') : '可以刷新 SIS 或导入已有 JSON。';
            if (state.version && state.version !== loaded) {
                const snapshot = await api('snapshot');
                if (mine !== sequence)
                    return;
                apply(snapshot.catalog, snapshot.history);
                loaded = state.version;
                node('snapshotDate').textContent = '上次同步 ' + new Date(snapshot.updated_at).toLocaleString('zh-CN');
            }
        }
        catch (error) {
            if (mine === sequence)
                status.textContent = '读取本地服务失败。' + errorText(error);
        }
        finally {
            if (mine === sequence)
                timer = window.setTimeout(poll, busy(active) ? 700 : 4500);
        }
    }
    scope.onchange = () => {
        const custom = scope.value === 'custom';
        node('customFields').hidden = !custom;
        field('major').required = custom;
    };
    form.onsubmit = async (event) => {
        event.preventDefault();
        const req = { scope: scope.value, term: field('term').value.trim(),
            subjects: field('subjects').value.trim().split(/[\s,，]+/).filter(Boolean),
            restart: field('restart').checked, ...(scope.value === 'custom' ? {
                major: field('major').value.trim(), stream: field('stream').value.trim(),
                cohort: field('cohort').value ? Number(field('cohort').value) : null
            } : {}) };
        ++sequence;
        clearTimeout(timer);
        submit.disabled = true;
        try {
            controls(await api('jobs', 'POST', req));
            field('restart').checked = false;
        }
        catch (error) {
            status.textContent = errorText(error);
            submit.disabled = false;
            timer = window.setTimeout(poll, 4500);
            return;
        }
        await poll();
    };
    cancel.onclick = async () => {
        if (!active)
            return;
        ++sequence;
        clearTimeout(timer);
        cancel.disabled = true;
        status.textContent = '正在取消刷新…';
        try {
            await api('jobs/' + active.id + '/cancel', 'POST');
        }
        catch (error) {
            status.textContent = errorText(error);
        }
        await poll();
    };
    api('profile').then(p => {
        node('profileLabel').textContent = [p.major || '本机默认查询全部专业', p.cohort ? String(p.cohort) + ' 级' : '', p.stream].filter(Boolean).join(' · ');
        if (!field('major').value)
            field('major').value = p.major;
        if (!field('cohort').value && p.cohort)
            field('cohort').value = String(p.cohort);
        if (!field('stream').value)
            field('stream').value = p.stream;
    }).catch(error => node('profileLabel').textContent = errorText(error));
    void poll();
}
