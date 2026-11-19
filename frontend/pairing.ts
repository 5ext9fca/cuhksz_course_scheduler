/** The scraper stores one optional SIS choice list on each lecture, keyed by class number. */
export interface TutorialOptions { required: boolean; class_numbers: string[] }
export function tutorialOptions(raw: unknown, tutorialIds: Set<string>, lecture: string): TutorialOptions|null {
  if(raw==null)return null;
  const data=raw as Partial<TutorialOptions>;
  if(typeof data.required!=='boolean'||!Array.isArray(data.class_numbers)||
     data.class_numbers.some(n=>typeof n!=='string'||!tutorialIds.has(n))){
    throw Error('讲课班 '+lecture+' 的 tutorial_options 无效或引用了其他课程的班号。');
  }
  return {required:data.required,class_numbers:[...new Set(data.class_numbers)]};
}
export function acceptsTutorial(rule: TutorialOptions|null, id: string|null): boolean {
  if(rule==null)return id!==null; // Legacy catalogs require one TUT whenever the course lists tutorials.
  return id===null?!rule.required:rule.class_numbers.includes(id);
}
