-- Seed 002 : Fonctionnalités disponibles pour le dashboard
-- Version : 1.0 | Idempotent

INSERT INTO konektag.features (feature_key, name_i18n, icon, sort_order, is_required) VALUES
    ('wallet',       '{"fr":"Wallet","en":"Wallet","ar":"محفظة","pt":"Carteira","es":"Billetera","sw":"Wallet","ha":"Wallet","yo":"Wallet","zh":"钱包","hi":"वॉलेट"}',
     'wallet',       1, true),
    ('send_money',   '{"fr":"Envoyer de l''argent","en":"Send Money","ar":"إرسال الأموال","pt":"Enviar dinheiro","es":"Enviar dinero","sw":"Tuma pesa","ha":"Aika kuɗi","yo":"Firanṣẹ owo","zh":"汇款","hi":"पैसे भेजें"}',
     'send',         2, true),
    ('receive_money','{"fr":"Recevoir de l''argent","en":"Receive Money","ar":"استلام الأموال","pt":"Receber dinheiro","es":"Recibir dinero","sw":"Pokea pesa","ha":"Karɓi kuɗi","yo":"Gba owo","zh":"收款","hi":"पैसे प्राप्त करें"}',
     'receive',      3, false),
    ('restaurants',  '{"fr":"Restaurants","en":"Restaurants","ar":"مطاعم","pt":"Restaurantes","es":"Restaurantes","sw":"Migahawa","ha":"Gidajen abinci","yo":"Awọn ile ounjẹ","zh":"餐厅","hi":"रेस्तरां"}',
     'restaurant',   4, false),
    ('hotels',       '{"fr":"Hôtels","en":"Hotels","ar":"فنادق","pt":"Hotéis","es":"Hoteles","sw":"Hoteli","ha":"Otal-otal","yo":"Awọn hotẹẹli","zh":"酒店","hi":"होटल"}',
     'hotel',        5, false),
    ('shops',        '{"fr":"Commerces","en":"Shops","ar":"متاجر","pt":"Lojas","es":"Tiendas","sw":"Maduka","ha":"Shaguna","yo":"Awọn itaja","zh":"商店","hi":"दुकानें"}',
     'shop',         6, false),
    ('events',       '{"fr":"Évènements","en":"Events","ar":"أحداث","pt":"Eventos","es":"Eventos","sw":"Matukio","ha":"Abubuwa","yo":"Awọn iṣẹlẹ","zh":"活动","hi":"आयोजन"}',
     'event',        7, false),
    ('promos',       '{"fr":"Promotions","en":"Promotions","ar":"عروض","pt":"Promoções","es":"Promociones","sw":"Matangazo","ha":"Talla","yo":"Awọn igbega","zh":"促销","hi":"प्रचार"}',
     'promo',        8, false),
    ('qr_scanner',   '{"fr":"Scanner QR Code","en":"QR Scanner","ar":"مسح رمز QR","pt":"Escanear QR","es":"Escanear QR","sw":"Scan QR","ha":"Scan QR","yo":"Ṣayẹwo QR","zh":"扫描二维码","hi":"क्यूआर स्कैन करें"}',
     'qr',           9, true),
    ('history',      '{"fr":"Historique","en":"History","ar":"السجل","pt":"Histórico","es":"Historial","sw":"Historia","ha":"Tarihi","yo":"Itan","zh":"历史","hi":"इतिहास"}',
     'history',      10, true),
    ('favorites',    '{"fr":"Favoris","en":"Favorites","ar":"المفضلة","pt":"Favoritos","es":"Favoritos","sw":"Vipendwa","ha":"Fifitawa","yo":"Ayanfẹ","zh":"收藏","hi":"पसंदीदा"}',
     'favorite',     11, false)
ON CONFLICT (feature_key) DO UPDATE SET
    name_i18n = EXCLUDED.name_i18n,
    icon = EXCLUDED.icon,
    sort_order = EXCLUDED.sort_order,
    is_required = EXCLUDED.is_required;
