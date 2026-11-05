# تفعيل الحسابات — تسجيل Google المفتوح (2.2)

السياسة الحالية بناءً على طلب المستخدم: **أي حساب Google مؤكد يستطيع التسجيل دون إضافته مسبقًا**، بما فيه Google Workspace. يدخل الجميع كطلاب، ويبقى إيميل الإدارة المهيأ ayobalbtoosh41@gmail.com مديرًا فقط. الحساب الذي يعطله المدير يظل معطلًا. الضيف بلا حفظ دائم.

## الخطوة المطلوبة للمشروع الحالي

المستخدم شغّل الإعداد القديم الذي كان يتطلب قائمة إيميلات. لتغيير مشروعه إلى السياسة الجديدة، يشغّل في SQL Editor الملف التالي كاملًا مرة واحدة:

[002_open_google_signup.sql](https://raw.githubusercontent.com/ayoubalbtoosh/islam/accounts-setup/supabase/migrations/002_open_google_signup.sql)

لا يحذف هذا التحديث المستخدمين أو التقدم أو النتائج. يحدّث دالة Hook نفسها والمحفّزات والتحقق من الوصول، ويضيف Google المؤكد تلقائيًا كطالب. لا يعيد تفعيل حساب معطل ولا يغير صلاحية المدير. ليس كافيًا تغيير نص الواجهة فقط.

للمشروع الجديد الذي لم يشغّل شيئًا، يستخدم supabase/setup-school.sql بدلًا منه؛ يجمع001 وتهيئة المدير و002 بالترتيب، وهو مختبر على قاعدة جديدة ومع إعادة التشغيل.

## إعداد Supabase وGoogle

1. في Authentication → Sign In / Providers فعّل Google وAllow new users to sign up. احتفظ بتأكيد البريد، واترك Anonymous Sign-ins مطفأ؛ الضيف محلي.
2. Hook Before User Created يمكن إبقاؤه مفعّلًا على public.before_user_created. بعد تشغيل002 يقبل Google تلقائيًا ويحافظ على الحظر الصريح؛ لا يحتاج أي قائمة بريد مسبقة لـGoogle.
3. من URL Configuration اضبط Site URL وRedirect URLs على https://ayoubalbtoosh.github.io/islam/، وأضف https://ayoubalbtoosh.github.io/islam/index.html لعناوين العودة.
4. أنشئ Google OAuth Web Client، وضع Callback URI: https://havrclbzugenqxbarjkl.supabase.co/auth/v1/callback . انسخ Client ID وClient Secret إلى Google Provider داخل Supabase فقط؛ السر لا يُرسل في المحادثة ولا يوضع في HTML.
5. إعداد Google نفسه يجب أن يسمح للجمهور المطلوب: اختر External، واستخدم In production / Publish app عند النشر. في Testing، ستبقى Google تشترط Test users مهما كانت سياسة الموقع مفتوحة. أكمل متطلبات Google التي يعرضها حسابك؛ لا تدّعي المنصة تجاوزها.
6. لا تطلب المنصة كلمة مرور Google. الدخول يتم عبر Google الرسمي؛ الحسابات السابقة بالبريد وكلمة المرور تظل مدعومة، دون إضافة واجهة تسجيل عام بكلمة مرور لأي بريد.

## الإعداد العام والحالة

URL والمفتاح العام الذي أرسله المستخدم موجودان في config/auth.public.json. لا يوجد مفتاح خدمة أو كلمة مرور. يمكن ضبط SUPABASE_URL وSUPABASE_PUBLISHABLE_KEY في إعدادات البناء، أو استخدام scripts/configure-auth.mjs ثم npm run build.

مشروع Supabase ظاهر في صور لوحة المستخدم، وظهر نجاح تنفيذ الإعداد الأصلي. تنفيذ الترقية002 وGoogle OAuth الحقيقي لم يُؤكدا بعد. طلب قراءة إعدادات الخدمة من بيئة العمل كان محجوبًا عندCONNECT403، لا نتيجة رفض من مشروع Supabase. الاختبارات المحلية والمحاكية لا تعني نجاح تسجيل فعلي على الخدمة المستضافة.

حالة المصدر والنشر في PUBLISH_STATUS.md. فتح الموقع النهائي لا يحتاج تنزيلًا أوVSCode؛ إعداد المزود وSQL إجراءات للمالك مرة واحدة، وليست خطوات للطلاب.
