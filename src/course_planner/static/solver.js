// Count valid suffixes so every schedule can be visited by rank without storing it.
import { acceptsTutorial } from './pairing.js';
let groups, allowed, all, memo;
function sameTeachingDay(a, b) {
    if (a.day !== b.day)
        return false;
    const start = Math.max(a.first, b.first), end = Math.min(a.last, b.last);
    if (start > end)
        return false;
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return true;
    const weekday = ((start + 3) % 7 + 7) % 7; // 1970-01-01 was Thursday.
    return start + (a.day - weekday + 7) % 7 <= end;
}
function conflict(a, b, gap) {
    if (a.code === b.code) {
        if (a.type === 'LEC' && b.type === 'TUT' && !acceptsTutorial(a.rule, b.id))
            return true;
        if (b.type === 'LEC' && a.type === 'TUT' && !acceptsTutorial(b.rule, a.id))
            return true;
    }
    return a.slots.some(x => b.slots.some(y => x.start < y.end + gap &&
        y.start < x.end + gap && sameTeachingDay(x, y)));
}
function prepare(input, gap) {
    groups = input.slice().sort((a, b) => a.length - b.length);
    all = groups.map(g => (1n << BigInt(g.length)) - 1n);
    allowed = groups.map((group, i) => group.map(s => groups.slice(i + 1).map((later, k) => {
        let mask = all[i + k + 1];
        later.forEach((t, j) => { if (conflict(s, t, gap))
            mask &= ~(1n << BigInt(j)); });
        return mask;
    })));
    memo = new Map();
}
function* branches(masks) {
    const level = groups.length - masks.length;
    for (let j = 0; j < groups[level].length; j++) {
        if (!(masks[0] & (1n << BigInt(j))))
            continue;
        const tail = allowed[level][j].map((mask, k) => mask & masks[k + 1]);
        if (!tail.includes(0n))
            yield [groups[level][j].id, tail];
    }
}
function count(masks) {
    if (!masks.length)
        return 1n;
    const key = masks.join(',');
    const cached = memo.get(key);
    if (cached !== undefined)
        return cached;
    let n = 0n;
    for (const [, tail] of branches(masks))
        n += count(tail);
    if (memo.size < 100000)
        memo.set(key, n);
    return n;
}
function at(rank) {
    const ids = [];
    let masks = all;
    while (masks.length) {
        let found = false;
        for (const [id, tail] of branches(masks)) {
            const n = count(tail);
            if (rank < n) {
                if (id !== null)
                    ids.push(id);
                masks = tail;
                found = true;
                break;
            }
            rank -= n;
        }
        if (!found)
            throw Error('方案编号超出范围');
    }
    return ids;
}
self.onmessage = ({ data }) => {
    try {
        if (data.groups) {
            prepare(data.groups, data.gap);
            const total = count(all);
            self.postMessage({ total: String(total), ids: total ? at(0n) : [], rank: '1' });
        }
        else
            self.postMessage({ ids: at(BigInt(data.rank) - 1n), rank: data.rank });
    }
    catch (e) {
        self.postMessage({ error: e instanceof Error ? e.message : String(e) });
    }
};
