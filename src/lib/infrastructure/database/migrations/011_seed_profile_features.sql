-- Seed 011 : Fonctionnalités supplémentaires pour profils professionnel, ambassadeur et agent
-- Version : 1.0 | Idempotent

INSERT INTO konektag.features (feature_key, name_i18n, icon, sort_order, is_required, is_active) VALUES
    -- ═══ Professionnel ═══
    ('merchant_payments',    '{"fr":"Encaissements","en":"Payments received","ar":"المدفوعات المستلمة","pt":"Pagamentos recebidos","es":"Pagos recibidos","sw":"Malipo yaliyopokelewa"}',
     'cash-register',       20, true, true),
    ('merchant_qr',          '{"fr":"QR Code commerçant","en":"Merchant QR Code","ar":"رمز QR للتاجر","pt":"QR Code do comerciante","es":"Código QR comercial","sw":"QR Code ya mfanyabiashara"}',
     'qr-code',             21, true, true),
    ('merchant_stats',       '{"fr":"Statistiques","en":"Statistics","ar":"الإحصائيات","pt":"Estatísticas","es":"Estadísticas","sw":"Takwimu"}',
     'chart-bar',           22, false, true),
    ('merchant_reviews',     '{"fr":"Avis clients","en":"Client reviews","ar":"مراجعات العملاء","pt":"Avaliações de clientes","es":"Reseñas de clientes","sw":"Maoni ya wateja"}',
     'star',                23, false, true),
    ('merchant_subscription','{"fr":"Abonnement pro","en":"Pro subscription","ar":"الاشتراك المهني","pt":"Assinatura profissional","es":"Suscripción profesional","sw":"Usajili wa kitaalamu"}',
     'badge-check',         24, false, true),

    -- ═══ Ambassadeur ═══
    ('missions_available',   '{"fr":"Missions disponibles","en":"Available missions","ar":"المهام المتاحة","pt":"Missões disponíveis","es":"Misiones disponibles","sw":"Misheni zinazopatikana"}',
     'clipboard-list',      30, true, true),
    ('missions_booked',      '{"fr":"Missions réservées","en":"Booked missions","ar":"المهام المحجوزة","pt":"Missões reservadas","es":"Misiones reservadas","sw":"Misheni zilizohifadhiwa"}',
     'calendar-check',      31, false, true),
    ('missions_active',      '{"fr":"Missions en cours","en":"Active missions","ar":"المهام النشطة","pt":"Missões ativas","es":"Misiones activas","sw":"Misheni zinazoendelea"}',
     'play-circle',         32, false, true),
    ('ambassador_commissions','{"fr":"Commissions","en":"Commissions","ar":"العمولات","pt":"Comissões","es":"Comisiones","sw":"Tume"}',
     'trending-up',         33, false, true),
    ('ambassador_history',   '{"fr":"Historique des gains","en":"Earnings history","ar":"سجل الأرباح","pt":"Histórico de ganhos","es":"Historial de ganancias","sw":"Historia ya mapato"}',
     'clock',               34, false, true),
    ('merchant_validation',  '{"fr":"Validation commerçants","en":"Merchant validation","ar":"التحقق من التجار","pt":"Validação de comerciantes","es":"Validación de comerciantes","sw":"Uthibitishaji wa wafanyabiashara"}',
     'shield-check',        35, false, true),

    -- ═══ Agent ═══
    ('agent_cashin',         '{"fr":"Encaissements Mobile Money","en":"Mobile Money cash-in","ar":"إيداع الأموال عبر الهاتف","pt":"Recebimentos Mobile Money","es":"Cobros Mobile Money","sw":"Malipo ya Mobile Money"}',
     'phone',               40, true, true),
    ('agent_withdrawals',    '{"fr":"Retraits / dépôts","en":"Withdrawals / deposits","ar":"السحب / الإيداع","pt":"Saques / depósitos","es":"Retiros / depósitos","sw":"Utoaji / amana"}',
     'arrows-exchange',     41, false, true),
    ('agent_commissions',    '{"fr":"Commissions agent","en":"Agent commissions","ar":"عمولات الوكيل","pt":"Comissões do agente","es":"Comisiones de agente","sw":"Tume za wakala"}',
     'cash',                42, false, true),
    ('agent_history',        '{"fr":"Historique opérations","en":"Operations history","ar":"سجل العمليات","pt":"Histórico de operações","es":"Historial de operaciones","sw":"Historia ya shughuli"}',
     'receipt',             43, false, true),
    ('agent_status',         '{"fr":"Statut agent","en":"Agent status","ar":"حالة الوكيل","pt":"Status do agente","es":"Estado del agente","sw":"Hali ya wakala"}',
     'user-check',          44, false, true),
    ('agent_performance',    '{"fr":"Performance","en":"Performance","ar":"الأداء","pt":"Desempenho","es":"Rendimiento","sw":"Utendaji"}',
     'chart-line',          45, false, true),

    -- ═══ Wallet et actions (tous profils) ═══
    ('wallet_balance',       '{"fr":"Solde du wallet","en":"Wallet balance","ar":"رصيد المحفظة","pt":"Saldo da carteira","es":"Saldo de la billetera","sw":"Salio ya pochi"}',
     'wallet',              46, true, true),
    ('quick_actions',        '{"fr":"Actions rapides","en":"Quick actions","ar":"إجراءات سريعة","pt":"Ações rápidas","es":"Acciones rápidas","sw":"Vitendo vya haraka"}',
     'zap',                 47, true, true)
ON CONFLICT (feature_key) DO UPDATE SET
    name_i18n = EXCLUDED.name_i18n,
    icon = EXCLUDED.icon,
    sort_order = EXCLUDED.sort_order,
    is_required = EXCLUDED.is_required,
    is_active = EXCLUDED.is_active;
