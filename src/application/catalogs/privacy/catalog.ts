export const privacyLocales = ['fr', 'en', 'ar', 'pt', 'es', 'sw', 'ha', 'yo', 'zh', 'hi'] as const;
type PrivacyLocale = (typeof privacyLocales)[number];

interface PrivacyContent {
  title: string;
  sections: { heading: string; body: string[] }[];
  version: string;
  address: string;
}

const catalogs: Record<PrivacyLocale, PrivacyContent> = {
  fr: {
    title: 'Politique de confidentialité',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, France — email : privacy@konektag.com.',
    sections: [
      { heading: '1. Responsable du traitement', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, France — email : privacy@konektag.com.'] },
      { heading: '2. Données collectées', body: ['Données d\'identification : nom, numéro de téléphone, pièce d\'identité.', 'Données financières : historiques d\'achats, soldes K.', 'Données techniques : adresse IP, modèle d\'appareil, logs.'] },
      { heading: '3. Finalités', body: ['Vérification d\'identité (LCB-FT), exécution des transactions, support client, analyses statistiques internes.'] },
      { heading: '4. Bases légales', body: ['Exécution du contrat (CGU).', 'Obligations légales (règlements ACPR / BEAC).', 'Intérêt légitime pour améliorer nos services.'] },
      { heading: '5. Durées de conservation', body: ['10 ans après la clôture du compte (obligations anti-blanchiment). Les journaux techniques sont conservés 12 mois.'] },
      { heading: '6. Vos droits', body: ['Accès, rectification, effacement, limitation, opposition et portabilité : envoyez un email à dpo@konektag.com.'] },
      { heading: '7. Sous-traitants et transferts', body: ['Stripe Payments Europe Ltd., GIMACPay, fournisseurs KYC (Sumsub). Les transferts hors UE sont encadrés par des clauses contractuelles types.'] },
      { heading: '8. Cookies', body: ['Cookies strictement nécessaires pour l\'authentification et la protection contre la fraude ; aucun cookie à des fins publicitaires.'] },
      { heading: '9. Contact autorité', body: ['Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la CNIL (www.cnil.fr).'] },
    ],
    version: 'Version 1.0 — mise à jour le 26 juillet 2026.',
  },
  en: {
    title: 'Privacy Policy',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, France — email: privacy@konektag.com.',
    sections: [
      { heading: '1. Data Controller', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, France — email: privacy@konektag.com.'] },
      { heading: '2. Data Collected', body: ['Identification data: name, phone number, ID document.', 'Financial data: purchase history, K balances.', 'Technical data: IP address, device model, logs.'] },
      { heading: '3. Purposes', body: ['Identity verification (AML/CFT), transaction processing, customer support, internal statistical analysis.'] },
      { heading: '4. Legal Bases', body: ['Performance of contract (Terms of Service).', 'Legal obligations (ACPR/BEAC regulations).', 'Legitimate interest in improving our services.'] },
      { heading: '5. Retention Periods', body: ['10 years after account closure (anti-money laundering obligations). Technical logs are retained for 12 months.'] },
      { heading: '6. Your Rights', body: ['Access, rectification, erasure, restriction, objection and portability: email dpo@konektag.com.'] },
      { heading: '7. Subcontractors & Transfers', body: ['Stripe Payments Europe Ltd., GIMACPay, KYC providers (Sumsub). Transfers outside the EU are governed by standard contractual clauses.'] },
      { heading: '8. Cookies', body: ['Strictly necessary cookies for authentication and fraud prevention; no advertising cookies.'] },
      { heading: '9. Supervisory Authority', body: ['If you believe your rights are not respected, you may contact the CNIL (www.cnil.fr).'] },
    ],
    version: 'Version 1.0 — updated July 26, 2026.',
  },
  ar: {
    title: 'سياسة الخصوصية',
    address: 'Konektag Europe SAS، 12 شارع الأمم، 75000 باريس، فرنسا — البريد الإلكتروني: privacy@konektag.com.',
    sections: [
      { heading: '1. المسؤول عن المعالجة', body: ['Konektag Europe SAS، 12 شارع الأمم، 75000 باريس، فرنسا — البريد الإلكتروني: privacy@konektag.com.'] },
      { heading: '2. البيانات المجمعة', body: ['بيانات التعريف: الاسم ورقم الهاتف ووثيقة الهوية.', 'البيانات المالية: سجل المشتريات وأرصدة K.', 'البيانات التقنية: عنوان IP وطراز الجهاز والسجلات.'] },
      { heading: '3. الأغراض', body: ['التحقق من الهوية (مكافحة غسل الأموال وتمويل الإرهاب) ومعالجة المعاملات ودعم العملاء والتحليلات الإحصائية الداخلية.'] },
      { heading: '4. الأسس القانونية', body: ['تنفيذ العقد (شروط الخدمة).', 'الالتزامات القانونية (لوائح ACPR/BEAC).', 'المصلحة المشروعة في تحسين خدماتنا.'] },
      { heading: '5. فترات الاحتفاظ', body: ['10 سنوات بعد إغلاق الحساب (التزامات مكافحة غسل الأموال). تُحتفظ بالسجلات التقنية لمدة 12 شهرًا.'] },
      { heading: '6. حقوقك', body: ['الوصول والتصحيح والمحو والتقييد والاعتراض وقابلية النقل: راسل dpo@konektag.com.'] },
      { heading: '7. المقاولون من الباطن والتحويلات', body: ['Stripe Payments Europe Ltd. وGIMACPay ومزودو التحقق من الهوية (Sumsub). تخضع التحويلات خارج الاتحاد الأوروبي لبنود تعاقدية نموذجية.'] },
      { heading: '8. ملفات تعريف الارتباط', body: ['ملفات تعريف ارتباط ضرورية تمامًا للمصادقة ومنع الاحتيال؛ لا توجد ملفات تعريف ارتباط للإعلانات.'] },
      { heading: '9. الاتصال بالسلطة', body: ['إذا كنت تعتقد أن حقوقك لم تُحترم، يمكنك الاتصال بـ CNIL (www.cnil.fr).'] },
    ],
    version: 'الإصدار 1.0 — آخر تحديث 26 يوليو 2026.',
  },
  pt: {
    title: 'Política de Privacidade',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, França — e-mail: privacy@konektag.com.',
    sections: [
      { heading: '1. Responsável pelo Tratamento', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, França — e-mail: privacy@konektag.com.'] },
      { heading: '2. Dados Recolhidos', body: ['Dados de identificação: nome, número de telefone, documento de identidade.', 'Dados financeiros: histórico de compras, saldos K.', 'Dados técnicos: endereço IP, modelo do dispositivo, registos.'] },
      { heading: '3. Finalidades', body: ['Verificação de identidade (LCB-FT), processamento de transações, apoio ao cliente, análises estatísticas internas.'] },
      { heading: '4. Bases Legais', body: ['Execução do contrato (Termos de Serviço).', 'Obrigações legais (regulamentos ACPR/BEAC).', 'Interesse legítimo em melhorar os nossos serviços.'] },
      { heading: '5. Períodos de Conservação', body: ['10 anos após o encerramento da conta (obrigações anti-branqueamento). Os registos técnicos são conservados 12 meses.'] },
      { heading: '6. Os Seus Direitos', body: ['Acesso, retificação, eliminação, limitação, oposição e portabilidade: envie email para dpo@konektag.com.'] },
      { heading: '7. Subcontratantes e Transferências', body: ['Stripe Payments Europe Ltd., GIMACPay, fornecedores KYC (Sumsub). As transferências para fora da UE são regidas por cláusulas contratuais-tipo.'] },
      { heading: '8. Cookies', body: ['Cookies estritamente necessários para autenticação e prevenção de fraudes; sem cookies publicitários.'] },
      { heading: '9. Contactar a Autoridade', body: ['Se considerar que os seus direitos não são respeitados, pode contactar a CNIL (www.cnil.fr).'] },
    ],
    version: 'Versão 1.0 — atualizada em 26 de julho de 2026.',
  },
  es: {
    title: 'Política de Privacidad',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 París, Francia — correo: privacy@konektag.com.',
    sections: [
      { heading: '1. Responsable del Tratamiento', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 París, Francia — correo: privacy@konektag.com.'] },
      { heading: '2. Datos Recogidos', body: ['Datos de identificación: nombre, número de teléfono, documento de identidad.', 'Datos financieros: historial de compras, saldos K.', 'Datos técnicos: dirección IP, modelo de dispositivo, registros.'] },
      { heading: '3. Finalidades', body: ['Verificación de identidad (LCB-FT), ejecución de transacciones, atención al cliente, análisis estadísticos internos.'] },
      { heading: '4. Bases Legales', body: ['Ejecución del contrato (Términos de Servicio).', 'Obligaciones legales (reglamentos ACPR/BEAC).', 'Interés legítimo en mejorar nuestros servicios.'] },
      { heading: '5. Plazos de Conservación', body: ['10 años tras el cierre de la cuenta (obligaciones anti-blanqueo). Los registros técnicos se conservan 12 meses.'] },
      { heading: '6. Sus Derechos', body: ['Acceso, rectificación, supresión, limitación, oposición y portabilidad: envíe un correo a dpo@konektag.com.'] },
      { heading: '7. Subcontratistas y Transferencias', body: ['Stripe Payments Europe Ltd., GIMACPay, proveedores KYC (Sumsub). Las transferencias fuera de la UE se rigen por cláusulas contractuales tipo.'] },
      { heading: '8. Cookies', body: ['Cookies estrictamente necesarias para la autenticación y prevención del fraude; sin cookies publicitarias.'] },
      { heading: '9. Contactar a la Autoridad', body: ['Si considera que sus derechos no son respetados, puede contactar con la CNIL (www.cnil.fr).'] },
    ],
    version: 'Versión 1.0 — actualizada el 26 de julio de 2026.',
  },
  sw: {
    title: 'Sera ya Faragha',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Ufaransa — barua pepe: privacy@konektag.com.',
    sections: [
      { heading: '1. Mdhibiti wa Data', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Ufaransa — barua pepe: privacy@konektag.com.'] },
      { heading: '2. Data Zilizokusanywa', body: ['Data za kitambulisho: jina, nambari ya simu, hati ya kitambulisho.', 'Data za kifedha: historia ya manunuzi, salio la K.', 'Data za kiufundi: anwani ya IP, mfano wa kifaa, kumbukumbu.'] },
      { heading: '3. Madhumuni', body: ['Uthibitishaji wa utambulisho (LCB-FT), utekelezaji wa miamala, usaidizi kwa wateja, uchambuzi wa takwimu za ndani.'] },
      { heading: '4. Misingi ya Kisheria', body: ['Utekelezaji wa mkataba (Masharti ya Huduma).', 'Majukumu ya kisheria (kanuni za ACPR/BEAC).', 'Maslahi halali katika kuboresha huduma zetu.'] },
      { heading: '5. Vipindi vya Uhifadhi', body: ['Miaka 10 baada ya kufungwa kwa akaunti (majukumu ya kupambana na utakatishaji fedha). Kumbukumbu za kiufundi huhifadhiwa kwa miezi 12.'] },
      { heading: '6. Haki Zako', body: ['Ufikiaji, urekebishaji, ufutaji, uzuiaji, upinzani na uhamishaji: tuma barua pepe kwa dpo@konektag.com.'] },
      { heading: '7. Wakandarasi Wadogo na Uhamishaji', body: ['Stripe Payments Europe Ltd., GIMACPay, watoa huduma za KYC (Sumsub). Uhamishaji nje ya EU unasimamiwa na vifungu vya kawaida vya kimkataba.'] },
      { heading: '8. Vidakuzi', body: ['Vidakuzi muhimu kabisa kwa uthibitishaji na kuzuia udanganyifu; hakuna vidakuzi vya matangazo.'] },
      { heading: '9. Wasiliana na Mamlaka', body: ['Ikiwa unaamini haki zako hazijaheshimiwa, unaweza kuwasiliana na CNIL (www.cnil.fr).'] },
    ],
    version: 'Toleo la 1.0 — lililosasishwa tarehe 26 Julai 2026.',
  },
  ha: {
    title: 'Manufofin Sirri',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Faransa — imel: privacy@konektag.com.',
    sections: [
      { heading: '1. Mai Kula Data', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Faransa — imel: privacy@konektag.com.'] },
      { heading: '2. Bayanan da Aka Tattara', body: ['Bayanan ganewa: suna, lambar waya, takardar shaida.', 'Bayanan kuɗi: tarihin sayayya, ma\u2019aunin K.', 'Bayanan fasaha: adireshin IP, samfurin na\u2019ura, rajistan ayyuka.'] },
      { heading: '3. Manufofi', body: ['Tabbatar da ainihi (LCB-FT), aiwatar da ma\u2019amaloli, tallafin abokin ciniki, nazarin kididdiga na cikin gida.'] },
      { heading: '4. Tushen Shari\u2019a', body: ['Aiwatar da kwangila (Sharuɗɗan Sabis).', 'Wajibcin shari\u2019a (dokokin ACPR/BEAC).', 'Sha\u2019awa ta halal wajen inganta ayyukanmu.'] },
      { heading: '5. Lokutan Adanawa', body: ['Shekaru 10 bayan rufe asusun (wajibcin yaƙi da halatta kuɗin haram). Ana adana rajistan ayyukan fasaha na watanni 12.'] },
      { heading: '6. Haƙƙoƙinka', body: ['Samun dama, gyara, sharewa, iyakancewa, adawa da ɗaukarwa: aika imel zuwa dpo@konektag.com.'] },
      { heading: '7. Ƙananan Kwangiloli da Canja wuri', body: ['Stripe Payments Europe Ltd., GIMACPay, masu samar da KYC (Sumsub). Canja wurin da ke wajen EU yana ƙarƙashin ƙa\u2019idodin kwangila na yau da kullun.'] },
      { heading: '8. Kukis', body: ['Kukis masu muhimmanci don tabbatarwa da hana zamba; babu kukis na talla.'] },
      { heading: '9. Tuntuɓi Hukuma', body: ['Idan kuna ganin ba a mutunta haƙƙoƙinku ba, kuna iya tuntuɓar CNIL (www.cnil.fr).'] },
    ],
    version: 'Sigar 1.0 — sabunta ranar 26 ga Yuli, 2026.',
  },
  yo: {
    title: 'Ilana Aṣiri',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Faransé — imeeli: privacy@konektag.com.',
    sections: [
      { heading: '1. Alakoso Data', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 Paris, Faransé — imeeli: privacy@konektag.com.'] },
      { heading: '2. Data Ti a Kojo', body: ['Data idanimọ: orukọ, nọmba foonu, iwe idanimọ.', 'Data inawo: itan rira, iwọntunwọnsi K.', 'Data imọ-ẹrọ: adirẹsi IP, awoṣe ẹrọ, àkọọlẹ.'] },
      { heading: '3. Awọn Idi', body: ['Ijẹrisi idanimọ (LCB-FT), ṣiṣe awọn iṣowo, atilẹyin alabara, itupalẹ iṣiro inu.'] },
      { heading: '4. Awọn Ipilẹ Ofin', body: ['Imuṣe adehun (Awọn ofin Iṣẹ).', 'Awọn ọranyan ofin (awọn ilana ACPR/BEAC).', 'Ifẹ ti o tọ ni imudarasi awọn iṣẹ wa.'] },
      { heading: '5. Awọn Akoko Ifipamọ', body: ['Ọdun 10 lẹhin pipade akọọlẹ (awọn ọranyan egboogi-owó-ìbàjẹ́). Awọn àkọọlẹ imọ-ẹrọ ni a fi pamọ fun oṣu 12.'] },
      { heading: '6. Awọn Ẹtọ Rẹ', body: ['Iwọle, atunṣe, piparẹ, idiwọn, atako ati gbigbe: fi imeeli ranṣẹ si dpo@konektag.com.'] },
      { heading: '7. Awọn Agbaṣe ati Awọn Gbigbe', body: ['Stripe Payments Europe Ltd., GIMACPay, awọn olupese KYC (Sumsub). Awọn gbigbe ni ita EU ni iṣakoso nipasẹ awọn gbolohun adehun boṣewa.'] },
      { heading: '8. Kuki', body: ['Kuki ti o jẹ dandan fun ijẹrisi ati idena jibiti; ko si kuki ipolowo.'] },
      { heading: '9. Kan si Alaṣẹ', body: ['Ti o ba ro pe awọn ẹtọ rẹ ko ni ọwọ, o le kan si CNIL (www.cnil.fr).'] },
    ],
    version: 'Ẹda 1.0 — imudojuiwọn ni Oṣu Keje 26, 2026.',
  },
  zh: {
    title: '隐私政策',
    address: 'Konektag Europe SAS，12 avenue des Nations，75000 巴黎，法国 — 邮箱：privacy@konektag.com。',
    sections: [
      { heading: '1. 数据控制者', body: ['Konektag Europe SAS，12 avenue des Nations，75000 巴黎，法国 — 邮箱：privacy@konektag.com。'] },
      { heading: '2. 收集的数据', body: ['身份数据：姓名、电话号码、身份证件。', '财务数据：购买记录、K 余额。', '技术数据：IP 地址、设备型号、日志。'] },
      { heading: '3. 目的', body: ['身份验证（反洗钱/反恐融资）、交易处理、客户支持、内部分析。'] },
      { heading: '4. 法律依据', body: ['履行合同（服务条款）。', '法律义务（ACPR/BEAC 法规）。', '改善我们服务的合法利益。'] },
      { heading: '5. 保留期限', body: ['账户关闭后保留 10 年（反洗钱义务）。技术日志保留 12 个月。'] },
      { heading: '6. 您的权利', body: ['访问、更正、删除、限制、反对和可携带性：发送邮件至 dpo@konektag.com。'] },
      { heading: '7. 分包商和转移', body: ['Stripe Payments Europe Ltd.、GIMACPay、KYC 提供商（Sumsub）。欧盟以外的转移受标准合同条款约束。'] },
      { heading: '8. Cookie', body: ['用于身份验证和防欺诈的严格必要 Cookie；无广告 Cookie。'] },
      { heading: '9. 联系监管机构', body: ['如果您认为您的权利未得到尊重，您可以联系 CNIL（www.cnil.fr）。'] },
    ],
    version: '版本 1.0 — 2026 年 7 月 26 日更新。',
  },
  hi: {
    title: 'गोपनीयता नीति',
    address: 'Konektag Europe SAS, 12 avenue des Nations, 75000 पेरिस, फ्रांस — ईमेल: privacy@konektag.com।',
    sections: [
      { heading: '1. डेटा नियंत्रक', body: ['Konektag Europe SAS, 12 avenue des Nations, 75000 पेरिस, फ्रांस — ईमेल: privacy@konektag.com।'] },
      { heading: '2. एकत्रित डेटा', body: ['पहचान डेटा: नाम, फोन नंबर, पहचान दस्तावेज।', 'वित्तीय डेटा: खरीद इतिहास, K शेष।', 'तकनीकी डेटा: IP पता, डिवाइस मॉडल, लॉग।'] },
      { heading: '3. उद्देश्य', body: ['पहचान सत्यापन (AML/CFT), लेन-देन प्रसंस्करण, ग्राहक सहायता, आंतरिक सांख्यिकीय विश्लेषण।'] },
      { heading: '4. कानूनी आधार', body: ['अनुबंध का निष्पादन (सेवा की शर्तें)।', 'कानूनी दायित्व (ACPR/BEAC नियम)।', 'हमारी सेवाओं में सुधार के लिए वैध हित।'] },
      { heading: '5. प्रतिधारण अवधि', body: ['खाता बंद होने के 10 वर्ष बाद (एंटी-मनी लॉन्ड्रिंग दायित्व)। तकनीकी लॉग 12 महीने तक रखे जाते हैं।'] },
      { heading: '6. आपके अधिकार', body: ['पहुंच, सुधार, मिटाना, सीमा, आपत्ति और पोर्टेबिलिटी: dpo@konektag.com पर ईमेल करें।'] },
      { heading: '7. उप-ठेकेदार और स्थानांतरण', body: ['Stripe Payments Europe Ltd., GIMACPay, KYC प्रदाता (Sumsub)। EU के बाहर स्थानांतरण मानक अनुबंध खंडों द्वारा शासित होते हैं।'] },
      { heading: '8. कुकीज़', body: ['प्रमाणीकरण और धोखाधड़ी रोकथाम के लिए कड़ाई से आवश्यक कुकीज़; कोई विज्ञापन कुकीज़ नहीं।'] },
      { heading: '9. प्राधिकरण से संपर्क', body: ['यदि आपको लगता है कि आपके अधिकारों का सम्मान नहीं किया गया है, तो आप CNIL (www.cnil.fr) से संपर्क कर सकते हैं।'] },
    ],
    version: 'संस्करण 1.0 — 26 जुलाई 2026 को अपडेट किया गया।',
  },
};

export function getPrivacyContent(locale: string | undefined): PrivacyContent {
  return catalogs[privacyLocales.includes(locale as PrivacyLocale) ? locale as PrivacyLocale : 'fr'];
}
