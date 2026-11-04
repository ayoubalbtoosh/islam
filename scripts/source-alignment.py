#!/usr/bin/env python3
"""Read-only lexical page alignment for the supplied question bank, NOT semantic certification.

Usage: python scripts/source-alignment.py --pdf /path/to/textbook.pdf
Requires PyMuPDF (pip install PyMuPDF). Produces only data/source-alignment.json
and replaces the marked aggregate appendix in two content reports.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import statistics
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
START = '<!-- SOURCE_ALIGNMENT_START -->'
END = '<!-- SOURCE_ALIGNMENT_END -->'
STOP = set('في من على الى عن ما لا لم لن ان بان فان او ام ثم هو هي هم هن هذا هذه ذلك تلك الذي التي الذين كل كما قد لقد كان كانت يكون تكون يكونون ليس ليست عند مع حتى بعد قبل بين بحسب وفق كما ورد الوارد الواردة الدرس الكتاب الصفحة يذكر ذكر يقرر السؤال اختر حدد رتب التالي التالية الاتي الاتية اي ما ماذا لماذا كيف كم هل ضع اذكر صح خطا صحيح خاطئ تعالى سبحانه رضي عنه عنها عنهم عليه عليهم السلام الله النبي رسول صلى وسلم'.split())
EXTRACTION_FIXES = {'اهلل':'الله', 'عىل':'على', 'إىل':'إلى', 'تعاىل':'تعالى', 'يف':'في', 'التي':'التي'}


def normalized(text):
    # NFKC expands Arabic presentation forms. No reordering of Quran glyphs is attempted.
    text = unicodedata.normalize('NFKC', str(text))
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn' and c != '\u0640')
    for old, new in EXTRACTION_FIXES.items():
        text = re.sub(r'(?<!\w)' + re.escape(old) + r'(?!\w)', new, text)
    text = text.translate(str.maketrans({'أ':'ا','إ':'ا','آ':'ا','ٱ':'ا','ى':'ي','ؤ':'و','ئ':'ي','ة':'ه'}))
    text = re.sub(r'[^\u0621-\u063a\u0641-\u064a0-9٠-٩\s]', ' ', text)
    return ' '.join(text.split())


def stem(token):
    # Only shallow clitic normalization: these are retrieval tokens, not linguistic parses.
    if len(token) >= 6 and token.startswith(('وال','فال','بال','كال')):
        token = token[3:]
    elif len(token) >= 5 and token.startswith('لل'):
        token = token[2:]
    elif len(token) >= 5 and token.startswith('ال'):
        token = token[2:]
    elif len(token) >= 5 and token[0] in 'وفب':
        token = token[1:]
    return token


STOP = {stem(t) for t in normalized(' '.join(STOP)).split()}


def tokens(text):
    return {stem(t) for t in normalized(text).split() if len(t) > 1 and stem(t) not in STOP}


def answer_components(q):
    payload, answer = q.get('payload', {}), q.get('answer', {})
    options = {x['id']:x['text'] for x in payload.get('options', [])}
    qtype = q['type']
    if qtype in ('multiple_choice','fill_blank'):
        return [options[answer['option_id']]], 'correct_option_text'
    if qtype == 'multi_select':
        return [options[i] for i in answer['option_ids']], 'correct_options_text'
    if qtype == 'matching':
        left = {x['id']:x['text'] for x in payload['left']}
        right = {x['id']:x['text'] for x in payload['right']}
        # Both sides are queried, but co-occurrence never proves the pair relation.
        return [text for p in answer['pairs'] for text in (left[p['left_id']],right[p['right_id']])], 'correct_pair_sides_not_relationship_validation'
    if qtype == 'ordering':
        items = {x['id']:x['text'] for x in payload['items']}
        # Presence does not validate the requested sequence.
        return [items[i] for i in answer['ordered_ids']], 'ordered_item_text_not_order_validation'
    if qtype == 'true_false':
        # The words true/false carry no subject evidence; align the statement itself.
        return [q['prompt']], 'statement_text_not_truth_value_validation'
    raise ValueError('Unsupported question type: ' + qtype)


def overlap(query, page_tokens):
    words = tokens(query)
    hits = words & page_tokens
    return {'query_token_count':len(words), 'matched_token_count':len(hits),
            'coverage':round(len(hits)/len(words),4) if words else None}


def append_section(path, section):
    text = path.read_text(encoding='utf-8')
    if START in text:
        before, rest = text.split(START,1)
        if END not in rest:
            raise ValueError('Unclosed alignment appendix marker in ' + str(path))
        _, after = rest.split(END,1)
        text = before.rstrip()+'\n\n'+section+after
    else:
        text = text.rstrip()+'\n\n'+section+'\n'
    path.write_text(text,encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',required=True,type=Path)
    args=parser.parse_args()
    import fitz
    bank_path=ROOT/'data/questions.json'
    bank=json.loads(bank_path.read_text(encoding='utf-8'))
    questions=bank['questions']; document=fitz.open(args.pdf)
    page_text={i+1:p.get_text() for i,p in enumerate(document)}
    page_norm={i:normalized(t) for i,t in page_text.items()}
    page_tokens={i:tokens(t) for i,t in page_text.items()}
    records=[]
    for q in questions:
        pages=q.get('source',{}).get('pdf_pages',[])
        if not pages or any(not isinstance(p,int) or p not in page_text for p in pages):
            raise ValueError('Missing or out-of-range source page: ' + q['id'])
        scope_tokens=set().union(*(page_tokens[p] for p in pages))
        components,basis=answer_components(q)
        answer=overlap(' '.join(components),scope_tokens)
        prompt=overlap(q['prompt'],scope_tokens)
        explanation=overlap(q.get('explanation',''),scope_tokens)
        exact=[]
        for index,text in enumerate(components):
            phrase=normalized(text)
            # Very short strings are trivial and not useful phrase evidence.
            matches=[p for p in pages if len(phrase)>=4 and len(phrase.split())>=2 and phrase in page_norm[p]]
            if matches:exact.append({'component_index':index,'pdf_pages':matches})
        values=[x['coverage'] for x in (answer,prompt,explanation) if x['coverage'] is not None]
        combined=round(statistics.mean(values),4) if values else None
        low=bool((answer['coverage'] is not None and answer['coverage']<.25) or (combined is not None and combined<.25))
        records.append({'id':q['id'],'type':q['type'],'pdf_pages':pages,'answer_basis':basis,
                        'answer':answer,'prompt':prompt,'explanation':explanation,
                        'mean_field_coverage':combined,'answer_components':len(components),
                        'exact_phrase_components':exact,'teacher_review_low_lexical_alignment':low})
    assert len(records)==len(questions) and len({r['id'] for r in records})==len(records)
    lows=[r['id'] for r in records if r['teacher_review_low_lexical_alignment']]
    no_exact=[r['id'] for r in records if not r['exact_phrase_components']]
    summary={'questions_compared':len(records),'type_counts':dict(Counter(r['type'] for r in records)),
             'cited_pdf_pages':len({p for r in records for p in r['pdf_pages']}),
             'questions_with_some_exact_answer_component_phrase':len(records)-len(no_exact),
             'questions_without_exact_answer_component_phrase':len(no_exact),
             'low_lexical_alignment_questions':len(lows),
             'mean_answer_token_coverage':round(statistics.mean(r['answer']['coverage'] for r in records if r['answer']['coverage'] is not None),4),
             'mean_prompt_token_coverage':round(statistics.mean(r['prompt']['coverage'] for r in records if r['prompt']['coverage'] is not None),4),
             'mean_explanation_token_coverage':round(statistics.mean(r['explanation']['coverage'] for r in records if r['explanation']['coverage'] is not None),4)}
    output={'schema_version':1,'audit_date':'2026-11-04',
            'question_bank_sha256':hashlib.sha256(bank_path.read_bytes()).hexdigest(),
            'pdf_sha256':hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
            'pdf_page_count':len(document),'summary':summary,
            'method':'Arabic NFKC, diacritic and punctuation removal, alif/ya/ta-marbuta normalization, shallow clitic stripping, stopwords and five known PDF extraction substitutions. Query unique-token coverage against union of cited PDF pages. Phrase hits require >=2 normalized words and >=4 characters.',
            'threshold_note':'Low alignment if answer-token coverage <0.25 or mean field coverage <0.25. This is a retrieval heuristic, never an exclusion or correctness rule.',
            'limitations':['Lexical occurrence does not establish religious correctness, uniqueness of correct distractor, or conceptual support.',
                          'Matching checks pair-side text presence, not correctness of the relationship; ordering checks text presence, not sequence.',
                          'True/false compares statement wording, not the asserted truth value. False statements can share almost all source words.',
                          'Quran text may use special glyphs in PDF; extraction, paraphrase, ligature damage and split words can reduce scores.',
                          'Exact normalized phrase occurrence is only location evidence. No new question was approved/excluded or edited by this script.'],
            'low_alignment_question_ids':lows,'no_exact_component_phrase_question_ids':no_exact,'questions':records}
    (ROOT/'data/source-alignment.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    section=f'''{START}
## المقارنة اللفظية الآلية لجميع صفحات مصدر الأسئلة

نُفذت `scripts/source-alignment.py` فعلًا على **{len(records)} سؤالًا** من الأنواع الستة وعلى النص المستخرج من صفحات PDF المشار إليها، وعددها **{summary['cited_pdf_pages']} صفحة مصدر مميزة**. قورنت مفردات السؤال والإجابة الصحيحة والشرح، بالإضافة إلى البحث عن مكونات الإجابة كعبارات مطبّعة؛ دون نسخ صفحات الكتاب في التقرير.

- ظهر مكوّن إجابة بعبارة مطبّعة متصلة في **{summary['questions_with_some_exact_answer_component_phrase']} سؤالًا**؛ لم تظهر عبارة مطابقة في **{summary['questions_without_exact_answer_component_phrase']}**.
- متوسط تغطية مفردات الإجابة: **{summary['mean_answer_token_coverage']*100:.2f}%**؛ السؤال: **{summary['mean_prompt_token_coverage']*100:.2f}%**؛ الشرح: **{summary['mean_explanation_token_coverage']*100:.2f}%**. هذه نسب استرجاع لفظي، وليست درجات صحة أو ثقة.
- وُسم **{len(lows)} سؤالًا** بمطابقة لفظية ضعيفة للمراجعة البشرية وفق عتبة 25% الموثقة. المعرفات والصفحات والدرجات محفوظة في `data/source-alignment.json`. لا تُستبعد أسئلة بناء على هذا الوسم.

لأسئلة التوصيل فُحص نصا طرفي العلاقة دون إثبات العلاقة، وللترتيب فُحصت مقاطع الإجابة دون إثبات ترتيبها، ولصح/خطأ فُحص نص العبارة دون إثبات قيمتها المنطقية. لا يثبت تطابق الكلمات صحة الدليل أو انفراد الإجابة. تؤثر إعادة الصياغة وأخطاء استخراج الخطوط والرموز القرآنية الخاصة في الدرجات؛ وانعدام العبارة لا يعني فساد السؤال.

هذه مقارنة لفظية **لكامل البنك**، تضاف إلى المقارنة التحريرية الدلالية للعينة البالغة **52 سؤالًا**. لا تحولها إلى ادعاء اعتماد علمي كامل أو مصادقة بشرية. لم يعدل الفحص بنك الأسئلة أو بيانات التشغيل.

للتكرار: `python scripts/source-alignment.py --pdf "مسار الكتاب.pdf"`، بعد تثبيت PyMuPDF. البصمات المسجلة تربط التقرير بنسخة الكتاب والبنك المستخدمتين.
{END}'''
    for name in ('QUESTION_BANK_AUDIT.md','CONTENT_COVERAGE.md'):
        append_section(ROOT/name,section)
    print(json.dumps(summary,ensure_ascii=False))
    return 0

if __name__=='__main__':
    raise SystemExit(main())
