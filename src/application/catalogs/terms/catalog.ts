export const termsLocales = ['fr', 'en', 'ar', 'pt', 'es', 'sw', 'ha', 'yo', 'zh', 'hi'] as const;
type TermsLocale = (typeof termsLocales)[number];

interface TermsContent {
  title: string;
  sections: { heading: string; body: string[] }[];
  version: string;
}

const catalogs: Record<TermsLocale, TermsContent> = {
  fr: {
    title: 'Conditions générales d\u2019utilisation',
    sections: [
      { heading: '1. Objet', body: ['Les présentes CGU régissent l\u2019accès et l\u2019utilisation de la plateforme Konektag et des crédits numériques K.'] },
      { heading: '2. Création de compte', body: ['Inscription réservée aux personnes majeures ; vérification d\u2019identité obligatoire dès le premier crédit, conformément à la réglementation LCB-FT.'] },
      { heading: '3. Achat de credits K', body: ['Les credits K sont des unites numeriques de valeur. Les droits eventuels de remboursement sont exerces aupres de l\'emetteur ou du PSP habilite selon le droit et le contrat applicables. Leur validite est illimitee tant que le service existe.'] },
      { heading: '4. Utilisation des credits K', body: ['Les credits K sont utilisables comme cadeau entre utilisateurs identifies et comme moyen de paiement aupres des commercants partenaires. Aucun retrait volontaire en especes n\'est disponible via le produit.'] },
      { heading: '5. Obligations utilisateur', body: ['Ne pas utiliser Konektag pour des activités illicites.', 'Conserver la confidentialité de ses identifiants.', 'Fournir des informations exactes et à jour.'] },
      { heading: '6. Suspension / résiliation', body: ['Nous pouvons suspendre ou clôturer un compte en cas de fraude, absence de KYC valide, ou violation grave des CGU.'] },
      { heading: '7. Responsabilités', body: ['Konektag décline toute responsabilité en cas de force majeure ou de mauvaise utilisation du service par l\u2019utilisateur.'] },
      { heading: '8. Loi applicable & juridiction', body: ['Le droit applicable et la juridiction compétente sont définis dans le contrat de service et les annexes du territoire concerné.'] },
    ],
    version: 'Version 1.0 — mise à jour le 26 juillet 2026.',
  },
  en: {
    title: 'Terms of Service',
    sections: [
      { heading: '1. Purpose', body: ['These Terms of Service govern access to and use of the Konektag platform and K digital credits.'] },
      { heading: '2. Account Creation', body: ['Registration is reserved for adults; identity verification is mandatory from the first credit, in accordance with AML/CFT regulations.'] },
      { heading: '3. Purchase of K Credits', body: ['K credits are digital value units. Any refund rights shall be exercised through the issuer or licensed PSP in accordance with applicable law and contract. Their validity is unlimited as long as the service exists.'] },
      { heading: '4. Use of K Credits', body: ['K credits are usable as gifts between identified users and as payment with partner merchants. No voluntary cash withdrawal is available through the product.'] },
      { heading: '5. User Obligations', body: ['Do not use Konektag for illegal activities.', 'Keep your credentials confidential.', 'Provide accurate and up-to-date information.'] },
      { heading: '6. Suspension / Termination', body: ['We may suspend or close an account in the event of fraud, lack of valid KYC, or serious breach of the Terms.'] },
      { heading: '7. Liability', body: ['Konektag disclaims all liability in the event of force majeure or misuse of the service by the user.'] },
      { heading: '8. Applicable Law & Jurisdiction', body: ['Applicable law and competent jurisdiction are defined in the service contract and the annexes for the relevant territory.'] },
    ],
    version: 'Version 1.0 — updated July 26, 2026.',
  },
  ar: {
    title: 'الشروط العامة للاستخدام',
    sections: [
      { heading: '1. الموضوع', body: ['تحكم هذه الشروط العامة للاستخدام الوصول إلى منصة Konektag واستخدامها والائتمانات الرقمية K.'] },
      { heading: '2. إنشاء الحساب', body: ['التسجيل مخصص للأشخاص البالغين؛ التحقق من الهوية إلزامي من أول ائتمان، وفقًا للوائح مكافحة غسل الأموال وتمويل الإرهاب.'] },
      { heading: '3. شراء ائتمانات K', body: ['ائتمانات K هي وحدات قيمة رقمية. تمارس حقوق الاسترداد المحتملة عبر المُصدر أو مزود خدمة الدفع المعتمد وفقًا للقانون والعقد الساريين. صلاحيتها غير محدودة طالما أن الخدمة موجودة.'] },
      { heading: '4. استخدام ائتمانات K', body: ['ائتمانات K قابلة للاستخدام كهدية بين المستخدمين المحددين وكوسيلة دفع لدى التجار الشركاء. لا يتوفر أي سحب نقدي طوعي عبر المنتج.'] },
      { heading: '5. التزامات المستخدم', body: ['عدم استخدام Konektag في أنشطة غير قانونية.', 'الحفاظ على سرية بيانات الاعتماد الخاصة بك.', 'تقديم معلومات دقيقة ومحدثة.'] },
      { heading: '6. التعليق / الإنهاء', body: ['يجوز لنا تعليق أو إغلاق الحساب في حالة الاحتيال أو عدم وجود تحقق هوية سارٍ أو انتهاك جسيم للشروط العامة للاستخدام.'] },
      { heading: '7. المسؤوليات', body: ['تخلي Konektag مسؤوليتها في حالة القوة القاهرة أو سوء استخدام الخدمة من قبل المستخدم.'] },
      { heading: '8. القانون المطبق والاختصاص القضائي', body: ['يُحدَّد القانون الواجب التطبيق والاختصاص القضائي في عقد الخدمة وملاحق الإقليم المعني.'] },
    ],
    version: 'الإصدار 1.0 — آخر تحديث 26 يوليو 2026.',
  },
  pt: {
    title: 'Termos de Utilização',
    sections: [
      { heading: '1. Objeto', body: ['Os presentes Termos regem o acesso e a utilização da plataforma Konektag e dos créditos digitais K.'] },
      { heading: '2. Criação de Conta', body: ['Inscrição reservada a maiores de idade; verificação de identidade obrigatória a partir do primeiro crédito, em conformidade com a regulamentação LCB-FT.'] },
      { heading: '3. Compra de Créditos K', body: ['Os créditos K são unidades digitais de valor. Os eventuais direitos de reembolso são exercidos junto do emitente ou PSP autorizado, nos termos da lei e do contrato aplicáveis. A sua validade é ilimitada enquanto o serviço existir.'] },
      { heading: '4. Utilização de Créditos K', body: ['Os créditos K podem ser utilizados como oferta entre utilizadores identificados e como meio de pagamento em comerciantes parceiros. Não está disponível qualquer levantamento voluntário em dinheiro.'] },
      { heading: '5. Obrigações do Utilizador', body: ['Não utilizar o Konektag para atividades ilícitas.', 'Manter a confidencialidade das suas credenciais.', 'Fornecer informações exatas e atualizadas.'] },
      { heading: '6. Suspensão / Rescisão', body: ['Podemos suspender ou encerrar uma conta em caso de fraude, ausência de KYC válido ou violação grave dos Termos.'] },
      { heading: '7. Responsabilidades', body: ['A Konektag declina qualquer responsabilidade em caso de força maior ou má utilização do serviço pelo utilizador.'] },
      { heading: '8. Lei Aplicável e Jurisdição', body: ['A lei aplicável e a jurisdição competente são definidas no contrato de serviço e nos anexos do território relevante.'] },
    ],
    version: 'Versão 1.0 — atualizada em 26 de julho de 2026.',
  },
  es: {
    title: 'Condiciones de Uso',
    sections: [
      { heading: '1. Objeto', body: ['Las presentes CGU rigen el acceso y uso de la plataforma Konektag y de los créditos digitales K.'] },
      { heading: '2. Creación de Cuenta', body: ['Inscripción reservada a personas mayores de edad; verificación de identidad obligatoria desde el primer crédito, conforme a la normativa LCB-FT.'] },
      { heading: '3. Compra de Créditos K', body: ['Los créditos K son unidades digitales de valor. Los eventuales derechos de reembolso se ejercen a través del emisor o PSP autorizado conforme a la ley y al contrato aplicables. Su validez es ilimitada mientras el servicio exista.'] },
      { heading: '4. Uso de Créditos K', body: ['Los créditos K pueden utilizarse como regalo entre usuarios identificados y como medio de pago en comercios asociados. No está disponible ningún retiro voluntario en efectivo.'] },
      { heading: '5. Obligaciones del Usuario', body: ['No utilizar Konektag para actividades ilícitas.', 'Conservar la confidencialidad de sus credenciales.', 'Proporcionar información exacta y actualizada.'] },
      { heading: '6. Suspensión / Rescisión', body: ['Podemos suspender o cerrar una cuenta en caso de fraude, ausencia de KYC válido o violación grave de las CGU.'] },
      { heading: '7. Responsabilidades', body: ['Konektag declina toda responsabilidad en caso de fuerza mayor o mal uso del servicio por parte del usuario.'] },
      { heading: '8. Ley Aplicable y Jurisdicción', body: ['La ley aplicable y la jurisdicción competente se definen en el contrato de servicio y sus anexos para el territorio correspondiente.'] },
    ],
    version: 'Versión 1.0 — actualizada el 26 de julio de 2026.',
  },
  sw: {
    title: 'Masharti ya Matumizi',
    sections: [
      { heading: '1. Kusudi', body: ['Masharti haya yanasimamia upatikanaji na matumizi ya jukwaa la Konektag na mikopo ya kidijitali ya K.'] },
      { heading: '2. Uundaji wa Akaunti', body: ['Usajili unafanywa na watu wazima pekee; uthibitishaji wa utambulisho ni lazima kutoka kwa mkopo wa kwanza, kwa mujibu wa kanuni za kupambana na utakatishaji fedha.'] },
      { heading: '3. Ununuzi wa Mikopo ya K', body: ['Mikopo ya K ni vipimo vya thamani ya kidijitali. Haki zozote za kurejeshewa fedha zitatekelezwa kupitia mtoaji au PSP mwenye leseni kwa mujibu wa sheria na mkataba husika. Uhalali wake hauna kikomo maadamu huduma ipo.'] },
      { heading: '4. Matumizi ya Mikopo ya K', body: ['Mikopo ya K inaweza kutumika kama zawadi kati ya watumiaji waliothibitishwa na kama malipo kwa wafanyabiashara washirika. Hakuna uondoaji wa hiari wa fedha unaopatikana kupitia bidhaa hii.'] },
      { heading: '5. Majukumu ya Mtumiaji', body: ['Usitumie Konektag kwa shughuli haramu.', 'Weka siri za kitambulisho chako.', 'Toa taarifa sahihi na zilizosasishwa.'] },
      { heading: '6. Kusimamishwa / Kukomeshwa', body: ['Tunaweza kusimamisha au kufunga akaunti katika kesi ya udanganyifu, ukosefu wa KYC halali, au ukiukaji mkubwa wa Masharti.'] },
      { heading: '7. Dhima', body: ['Konektag inakanusha dhima yote katika kesi ya nguvu kubwa au matumizi mabaya ya huduma na mtumiaji.'] },
      { heading: '8. Sheria Inayotumika na Mamlaka ya Mahakama', body: ['Sheria inayotumika na mamlaka yenye uwezo hufafanuliwa katika mkataba wa huduma na viambatisho vya eneo husika.'] },
    ],
    version: 'Toleo la 1.0 — lilisasishwa tarehe 26 Julai 2026.',
  },
  ha: {
    title: 'Sharuɗɗan Amfani',
    sections: [
      { heading: '1. Manufa', body: ['Waɗannan Sharuɗɗan suna tsara damar shiga da amfani da dandalin Konektag da ƙididdigar dijital na K.'] },
      { heading: '2. Ƙirƙirar Asusu', body: ['Rajista ta keɓance ga manya; tabbatar da ainihi wajibi ne daga ƙididdigar farko, bisa ka\u2019idojin yaƙi da halatta kuɗin haram.'] },
      { heading: '3. Siyan Ƙididdigar K', body: ['Ƙididdigar K raka\'o\'in ƙimar dijital ne. Duk wani haƙƙin dawo da kuɗi ana aiwatar da shi ta hannun mai bayarwa ko PSP mai lasisi bisa doka da kwangilar da suka dace. Ingantaccen su ba shi da iyaka matuƙar sabis ɗin yana nan.'] },
      { heading: '4. Amfani da Ƙididdigar K', body: ['Ana iya amfani da ƙididdigar K azaman kyauta tsakanin masu amfani da aka tantance da kuma hanyar biyan kuɗi tare da \'yan kasuwa abokan hulɗa. Babu wani cire kuɗi na son rai da ke samuwa ta wannan samfurin.'] },
      { heading: '5. Wajibcin Mai Amfani', body: ['Kada a yi amfani da Konektag don ayyukan haram.', 'Kiyaye sirrin bayanan shiga.', 'Bayar da cikakkun bayanai na zamani.'] },
      { heading: '6. Dakatarwa / Ƙarewa', body: ['Muna iya dakatarwa ko rufe asusu a yayin zamba, rashin KYC mai inganci, ko keta Sharuɗɗan mai tsanani.'] },
      { heading: '7. Alhaki', body: ['Konektag ba ta da wani alhaki a yayin ƙarfin hali ko rashin amfani da sabis ɗin ta mai amfani.'] },
      { heading: '8. Dokar da ta dace & Hukuma', body: ['Dokar da ta dace da kotun da ke da hurumin jihohi ana bayyana su a cikin kwangilar sabis da takardun yankin da ya shafa.'] },
    ],
    version: 'Sigar 1.0 — sabunta ranar 26 ga Yuli, 2026.',
  },
  yo: {
    title: 'Awọn ofin Lilo',
    sections: [
      { heading: '1. Idi', body: ['Awọn ofin wọnyi n ṣakoso iraye si ati lilo pẹpẹ Konektag ati awọn kirẹditi oni nọmba K.'] },
      { heading: '2. Ṣiṣẹda Akọọlẹ', body: ['Iforukọsilẹ wa fun awọn agba nikan; ijẹrisi idanimọ jẹ dandan lati kirẹditi akọkọ, ni ibamu pẹlu awọn ilana LCB-FT.'] },
      { heading: '3. Ifẹ si Ra Kirẹditi K', body: ['Awọn kirẹditi K jẹ awọn ẹya iye oni nọmba. Awọn ẹtọ agbapada eyikeyi ni a gbọdọ gba nipasẹ olufunni tabi PSP ti o ni iwe-aṣẹ ni ibamu pẹlu ofin ati adehun to wulo. Wọn wulo titi lailai niwọn igba ti iṣẹ naa ba wa.'] },
      { heading: '4. Lilo Awọn Kirẹditi K', body: ['Awọn kirẹditi K jẹ lilo bi ẹbun laarin awọn olumulo ti a ti damọ ati bi ọna isanwo pẹlu awọn oniṣowo alabaṣiṣẹpọ. Ko si yiyọ owo atinuwa eyikeyi ti o wa nipasẹ ọja naa.'] },
      { heading: '5. Awọn Iṣeduro Olumulo', body: ['Maṣe lo Konektag fun awọn iṣẹ arufin.', 'Tọju aṣiri awọn iwe-ẹri rẹ.', 'Pese alaye deede ati imudojuiwọn.'] },
      { heading: '6. Idaduro / Ifopinṣe', body: ['A le da duro tabi pa akọọlẹ kan ni iṣẹlẹ ti jibiti, aini KYC to wulo, tabi irufin nla ti Awọn ofin.'] },
      { heading: '7. Awọn Ojuse', body: ['Konektag ko ni ojuse kankan ni iṣẹlẹ ti agbara nla tabi ilokulo iṣẹ naa nipasẹ olumulo.'] },
      { heading: '8. Ofin to wulo & Ẹjọ', body: ['Ofin to wulo ati ile-ẹjọ to ni aṣẹ ni a ṣalaye ninu adehun iṣẹ ati awọn afijẹẹri agbegbe to ba kan.'] },
    ],
    version: 'Ẹda 1.0 — imudojuiwọn ni Oṣu Keje 26, 2026.',
  },
  zh: {
    title: '使用条款',
    sections: [
      { heading: '1. 目的', body: ['本使用条款规范对 Konektag 平台及数字信用 K 的访问和使用。'] },
      { heading: '2. 创建账户', body: ['注册仅限成年人；从首次充值起必须进行身份验证，符合反洗钱/反恐融资法规。'] },
      { heading: '3. 购买 K 信用', body: ['K 信用是数字价值单位。任何退款权利应通过发行方或持牌支付服务商根据适用法律和合同行使。只要服务存在，其有效期无限。'] },
      { heading: '4. 使用 K 信用', body: ['K 信用可作为已识别用户之间的礼物使用，也可在合作商户处作为支付方式。本产品不提供任何自愿现金提取。'] },
      { heading: '5. 用户义务', body: ['不得将 Konektag 用于非法活动。', '保守您的凭据机密。', '提供准确且最新的信息。'] },
      { heading: '6. 暂停/终止', body: ['在欺诈、缺少有效 KYC 或严重违反条款的情况下，我们可能会暂停或关闭账户。'] },
      { heading: '7. 责任', body: ['Konektag 对不可抗力或用户不当使用服务不承担任何责任。'] },
      { heading: '8. 适用法律与管辖权', body: ['适用法律和管辖权在服务合同及相关区域附录中定义。'] },
    ],
    version: '版本 1.0 — 2026 年 7 月 26 日更新。',
  },
  hi: {
    title: 'उपयोग की शर्तें',
    sections: [
      { heading: '1. उद्देश्य', body: ['ये उपयोग की शर्तें Konektag प्लेटफॉर्म और डिजिटल क्रेडिट K तक पहुंच और उपयोग को नियंत्रित करती हैं।'] },
      { heading: '2. खाता निर्माण', body: ['पंजीकरण केवल वयस्कों के लिए है; पहले क्रेडिट से पहचान सत्यापन अनिवार्य है, एएमएल/सीएफटी नियमों के अनुसार।'] },
      { heading: '3. K क्रेडिट की खरीद', body: ['K क्रेडिट डिजिटल मूल्य इकाइयाँ हैं। किसी भी धनवापसी के अधिकार लागू कानून और अनुबंध के अनुसार जारीकर्ता या लाइसेंस प्राप्त PSP के माध्यम से प्रयोग किए जाएंगे। सेवा के मौजूद रहने तक इनकी वैधता असीमित है।'] },
      { heading: '4. K क्रेडिट का उपयोग', body: ['K क्रेडिट पहचाने गए उपयोगकर्ताओं के बीच उपहार के रूप में और भागीदार व्यापारियों पर भुगतान के रूप में उपयोग किए जा सकते हैं। इस उत्पाद के माध्यम से कोई स्वैच्छिक नकद निकासी उपलब्ध नहीं है।'] },
      { heading: '5. उपयोगकर्ता दायित्व', body: ['Konektag का उपयोग अवैध गतिविधियों के लिए न करें।', 'अपने क्रेडेंशियल की गोपनीयता बनाए रखें।', 'सटीक और अद्यतित जानकारी प्रदान करें।'] },
      { heading: '6. निलंबन / समाप्ति', body: ['धोखाधड़ी, वैध KYC की कमी, या शर्तों के गंभीर उल्लंघन की स्थिति में हम खाते को निलंबित या बंद कर सकते हैं।'] },
      { heading: '7. दायित्व', body: ['Konektag अप्रत्याशित घटना या उपयोगकर्ता द्वारा सेवा के दुरुपयोग की स्थिति में सभी दायित्व से इनकार करता है।'] },
      { heading: '8. लागू कानून और क्षेत्राधिकार', body: ['लागू कानून और सक्षम क्षेत्राधिकार सेवा अनुबंध और संबंधित क्षेत्र के परिशिष्टों में परिभाषित हैं।'] },
    ],
    version: 'संस्करण 1.0 — 26 जुलाई 2026 को अपडेट किया गया।',
  },
};

export function getTermsContent(locale: string | undefined): TermsContent {
  return catalogs[termsLocales.includes(locale as TermsLocale) ? locale as TermsLocale : 'fr'];
}
