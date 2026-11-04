#!/usr/bin/env python3
"""Structural content audit. --pdf adds current PDF page/hash checks; never certifies theology."""
import argparse, collections, hashlib, json, re, unicodedata
from difflib import SequenceMatcher
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def normalize(s):
    s = ''.join(c for c in unicodedata.normalize('NFKC', str(s)) if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^\w\s]', '', s).strip()
def load(name):
    return json.loads((ROOT / 'data' / name).read_text(encoding='utf-8'))
def errors(q, lessons):
    err=[]
    def need(ok, msg):
        if not ok: err.append(msg)
    need(isinstance(q.get('id'),str) and bool(re.fullmatch(r'u0[1-4]_l\d{2}_q\d{3}',q.get('id',''))),'invalid_id')
    need(q.get('lesson_id') in lessons,'unknown_lesson')
    need(q.get('unit_id') == q.get('lesson_id','')[:3],'wrong_unit')
    need(q.get('difficulty') in ['easy','medium','hard'],'invalid_difficulty')
    need(bool(str(q.get('prompt','')).strip()),'missing_prompt')
    need(bool(str(q.get('explanation','')).strip()),'missing_explanation')
    pages=q.get('source',{}).get('printed_pages',[])
    need(isinstance(pages,list) and bool(pages) and all(isinstance(x,int) and x>0 for x in pages),'invalid_source')
    p=q.get('payload',{}); a=q.get('answer',{}); t=q.get('type')
    def valid_items(items):
        return isinstance(items,list) and len(items)>1 and all(isinstance(x,dict) and isinstance(x.get('id'),str) and bool(str(x.get('text','')).strip()) for x in items) and len({x['id'] for x in items})==len(items) and len({normalize(x['text']) for x in items})==len(items)
    if t in ['multiple_choice','fill_blank','multi_select']:
        options=p.get('options',[]); need(valid_items(options),'invalid_options'); ids=[x.get('id') for x in options]
        if t=='multiple_choice':need(len(options)==4,'mcq_not_four_options')
        if t=='multi_select':
            values=a.get('option_ids',[]);need(isinstance(values,list) and len(values)>0 and len(set(values))==len(values) and all(v in ids for v in values),'invalid_answer_set')
        else:need(a.get('option_id') in ids,'answer_not_in_options')
    elif t=='true_false':need(isinstance(a.get('value'),bool),'invalid_boolean')
    elif t=='matching':
        left=p.get('left',[]); right=p.get('right',[]);pairs=a.get('pairs',[])
        need(valid_items(left) and valid_items(right) and len(left)==len(right),'invalid_matching_items')
        need(isinstance(pairs,list) and len(pairs)==len(left) and {x.get('left_id') for x in pairs}=={x.get('id') for x in left} and {x.get('right_id') for x in pairs}=={x.get('id') for x in right},'invalid_matching_answer')
    elif t=='ordering':
        items=p.get('items',[]); values=a.get('ordered_ids',[])
        need(valid_items(items),'invalid_ordering_items')
        need(isinstance(values,list) and len(values)==len(items) and set(values)=={x.get('id') for x in items},'invalid_ordering_answer')
    else:need(False,'unsupported_type')
    return err

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pdf',type=Path);args=parser.parse_args()
    bank=load('questions.json');units=load('lessons.json');questions=bank['questions']; lessons={l['id']:l for u in units for l in u['lessons']}
    invalid=[{'id':q.get('id'),'errors':errors(q,lessons)} for q in questions if errors(q,lessons)]
    invalid_ids={x['id'] for x in invalid};eligible=[q for q in questions if q['id'] not in invalid_ids and q.get('review',{}).get('source_checked') is True]
    excluded=[{'id':q['id'],'reason':'structural_error' if q['id'] in invalid_ids else 'legacy_draft_source_unchecked'} for q in questions if q not in eligible]
    prompts=collections.defaultdict(list)
    for q in questions:prompts[normalize(q['prompt'])].append(q['id'])
    duplicates=[v for v in prompts.values() if len(v)>1]
    similar=[]
    for lesson in lessons:
        rows=[q for q in questions if q['lesson_id']==lesson]
        for i,q in enumerate(rows):
            for other in rows[i+1:]:
                a,b=normalize(q['prompt']),normalize(other['prompt'])
                if min(len(a),len(b))<20 or min(len(a),len(b))/max(len(a),len(b))<.82:continue
                ratio=SequenceMatcher(None,a,b,autojunk=False).ratio()
                if ratio>=.86:similar.append({'ids':[q['id'],other['id']],'similarity':round(ratio,3),'status':'teacher_review_candidate_not_proven_duplicate'})
    pdf_evidence={'checked_this_run':False,'note':'Pass --pdf to repeat extraction and page checks; stored sample evidence is editorial, not automatic proof.'}
    if args.pdf:
        import fitz
        document=fitz.open(args.pdf);pdf_evidence={'checked_this_run':True,'pages':len(document),'sha256':hashlib.sha256(args.pdf.read_bytes()).hexdigest(),'text_pages':sum(bool(p.get_text().strip()) for p in document),'quran_glyph_limitation':True}
        pdf_evidence['out_of_range_question_ids']=[q['id'] for q in questions if any(p<1 or p>len(document) for p in q['source'].get('pdf_pages',[]))]
    lesson_rows=[]
    for lesson in lessons.values():
        imported=[q for q in questions if q['lesson_id']==lesson['id']];active=[q for q in eligible if q['lesson_id']==lesson['id']]
        lesson_rows.append({'id':lesson['id'],'name':lesson['name'],'imported':len(imported),'eligible':len(active),'excluded':len(imported)-len(active),'difficulty_imported':dict(collections.Counter(q['difficulty'] for q in imported)),'difficulty_eligible':dict(collections.Counter(q['difficulty'] for q in active)),'types':dict(collections.Counter(q['type'] for q in active)),'sample_checked':sum(q['review'].get('verification_status')=='sample_checked' for q in imported)})
    single=[q for q in eligible if q['type'] in ['multiple_choice','fill_blank']]
    longest=sum(len(next(o['text'] for o in q['payload']['options'] if o['id']==q['answer']['option_id']))>max(len(o['text']) for o in q['payload']['options'] if o['id']!=q['answer']['option_id']) for q in single)
    report={'schema_version':1,'audit_date':'2026-11-04','total_units':len(units),'total_lessons':len(lessons),'total_questions':len(questions),'structurally_valid':len(questions)-len(invalid),'eligible_questions':len(eligible),'excluded_questions':len(excluded),'scientifically_certified_questions':0,'sample_checked_questions':sum(q['review'].get('verification_status')=='sample_checked' for q in questions),'human_review_pending':sum(q['review'].get('verification_status')=='needs_human_review' for q in questions),'types_imported':dict(collections.Counter(q['type'] for q in questions)),'types_eligible':dict(collections.Counter(q['type'] for q in eligible)),'difficulty_imported':dict(collections.Counter(q['difficulty'] for q in questions)),'difficulty_eligible':dict(collections.Counter(q['difficulty'] for q in eligible)),'duplicate_id_count':len(questions)-len({q['id'] for q in questions}),'duplicate_prompt_groups':duplicates,'near_duplicate_candidates':similar,'missing_explanations':sum(not q.get('explanation','').strip() for q in questions),'missing_sources':sum(not q.get('source',{}).get('printed_pages') for q in questions),'single_answer_id_distribution':dict(collections.Counter(q['answer']['option_id'] for q in single)),'correct_is_uniquely_longest':{'count':longest,'denominator':len(single)},'invalid':invalid,'excluded':excluded,'lessons':lesson_rows,'pdf':pdf_evidence,'semantic_verification_note':'Eligibility means structural usability plus original editorial inclusion. It is NOT complete independent religious verification. All records require teacher sign-off before formal assessment.'}
    for filename, rows in [('approved-questions.json',eligible),('excluded-questions.json',[q for q in questions if q['id'] in {x['id'] for x in excluded}])]:
        payload={'schema_version':bank['schema_version'],'document_id':bank['document_id'],'question_count':len(rows),'eligibility_note':'Technical/editorial eligibility is not complete scientific certification. See CONTENT_COVERAGE.md.','questions':rows}
        (ROOT/'data'/filename).write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'data/content-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    rows=['# تدقيق بنك الأسئلة','', 'أُجري التدقيق على البيانات المستخرجة من HTML الأصلي، وليس على الأرقام الوصفية. تاريخ التقرير: 2026-11-04.','',f"- الوحدات: {len(units)}. الدروس: {len(lessons)}.",f"- المستورد: {len(questions)}. السليم بنيويًا: {len(questions)-len(invalid)}.",f"- المؤهل تقنيًا للعب: {len(eligible)}. المستبعد من اللعب والمحَفوظ في البيانات: {len(excluded)} مسودة لم يعتمدها المصدر الأصلي.",'- المطابقة العلمية الكاملة لكل البنك: **لم تنفذ ولم يُدّعَ تنفيذها**. مصدر checked القديم ليس دليل تحقق مستقل.',f"- عينة المقارنة الفعلية: {report['sample_checked_questions']} سؤالًا؛ أول سؤال وآخر سؤال من كل درس، مع السؤال والإجابة والشرح والصفحات. حالة `sample_checked` لا تعني اعتماد عالم أو معلم.",f"- تحتاج مراجعة بشرية تفصيلية: {report['human_review_pending']} سؤالًا إضافة إلى المسودات والاعتماد النهائي للعينة.",f"- معرفات مكررة: {report['duplicate_id_count']}. مجموعات نصوص متطابقة بعد التطبيع: {len(duplicates)}. مرشحات تشابه لفظي ≥86%: {len(similar)}، وهي ليست إثبات تكرار معرفي.",f"- شرح مفقود: {report['missing_explanations']}. مصدر مفقود: {report['missing_sources']}. أخطاء بنيوية: {len(invalid)}.",'','## الأنواع والصعوبة','', '| النوع | المستورد | المؤهل للعب |','|---|---:|---:|']
    for t,n in report['types_imported'].items():rows.append(f"| {t} | {n} | {report['types_eligible'].get(t,0)} |")
    rows.extend(['','| الصعوبة | المستورد | المؤهل للعب |','|---|---:|---:|'])
    for t,n in report['difficulty_imported'].items():rows.append(f"| {t} | {n} | {report['difficulty_eligible'].get(t,0)} |")
    rows.extend(['','## الدروس','', '| الدرس | الاسم | مستورد | مؤهل | مستبعد | سهل/متوسط/صعب مؤهل |','|---|---|---:|---:|---:|---|'])
    for l in lesson_rows:rows.append(f"| {l['id']} | {l['name']} | {l['imported']} | {l['eligible']} | {l['excluded']} | {' / '.join(str(l['difficulty_eligible'].get(d,0)) for d in ['easy','medium','hard'])} |")
    rows.extend(['','## الخيارات والتوثيق','',f"موضع معرف الإجابة الأحادية: `{report['single_answer_id_distribution']}`. يخلط المحرك العرض مع إبقاء المعرفات؛ هذه الأرقام ليست المواضع المرئية. كانت/أصبحت الإجابة الصحيحة أطول خيار منفرد في {longest} من {len(single)} سؤالًا مؤهلًا؛ هذه إشارة تربوية تتطلب تحريرًا إضافيًا، وليست دليل بطلان.",'','حُسّنت مشتتات 20 سؤالًا: 18 من الأسئلة الأولى ومشتتان متداخلان في سؤالين صعبين. وُضح نطاق سؤال ميراث، واكتمل شرحان، وصححت خمس إحالات ناقصة. سجل قبل/بعد في `data/content-changes.json`. لم تُضف أسئلة لملء العدد ولم تُخترع نصوص دينية.','', 'كل درس كان يحتوي 30 سؤالًا لكل صعوبة في المستورد. الاستبعاد المقصود يجعل بعض الدروس أقل من الهدف. لا يجوز تعويض النقص بصياغات شكلية.','', '## إعادة التنفيذ','', '`python scripts/audit-content.py` يعيد فحص البنية والتوزيع. استخدم `--pdf "مسار الكتاب.pdf"` لإعادة فحص الصفحات وبصمة الملف. تعتمد هذه الزيادة على PyMuPDF. لا يثبت تطابق أرقام الصفحات وحده صحة السؤال.','', '## القيود المتبقية','', '- لم تُراجع مشتتات الأسئلة الـ2340 جميعها يدويًا؛ تبقى عبارات سهلة الاستبعاد وتكرارات مفاهيمية تحتاج لجنة تربوية.','- الصعوبة تصنيف موروث ولم تُعاير إحصائيًا على طلاب.','- قد تُستخرج آيات PDF برموز خاصة؛ لم يُستخدم استخراج النص لإثبات سلامة الرسم القرآني أو التشكيل.','- لا توجد أنواع برمجية إضافية مصطنعة: التصنيف/من أنا/اختيار الدليل إن ورد في صياغة سؤال يبقى نوعه البنيوي الأصلي، والواجهات الأصلية الست منفصلة.'])
    if args.pdf:rows.extend(['',f"فُتح PDF فعلًا: {pdf_evidence['pages']} صفحة، {pdf_evidence['text_pages']} صفحة قابلة للاستخراج؛ بصمة SHA-256: `{pdf_evidence['sha256']}`. صفحات خارج PDF: {len(pdf_evidence['out_of_range_question_ids'])}."])
    (ROOT/'QUESTION_BANK_AUDIT.md').write_text('\n'.join(rows)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['total_questions','structurally_valid','eligible_questions','excluded_questions','sample_checked_questions','human_review_pending']},ensure_ascii=False))
    return 1 if invalid or report['duplicate_id_count'] else 0
if __name__=='__main__': raise SystemExit(main())
