export const POSITIVE_WORDS = new Set([
  'amazing',
  'awesome',
  'best',
  'brilliant',
  'excellent',
  'fantastic',
  'favorite',
  'flawless',
  'good',
  'great',
  'happy',
  'impressed',
  'incredible',
  'love',
  'loved',
  'perfect',
  'pleased',
  'recommend',
  'recommended',
  'satisfied',
  'solid',
  'superb',
  'terrific',
  'wonderful',
  'works',
  'worth',
  'quality',
  'comfortable',
  'easy',
  'beautiful',
  'sturdy',
  'reliable',
  'fast',
]);

export const NEGATIVE_WORDS = new Set([
  'awful',
  'bad',
  'broken',
  'cheap',
  'defective',
  'disappointed',
  'disappointing',
  'failed',
  'failure',
  'fake',
  'flimsy',
  'garbage',
  'hate',
  'hated',
  'horrible',
  'junk',
  'leak',
  'leaked',
  'misleading',
  'poor',
  'refund',
  'returned',
  'ripped',
  'scam',
  'terrible',
  'useless',
  'waste',
  'worse',
  'worst',
  'damaged',
  'dirty',
  'smell',
  'stopped',
  'uncomfortable',
  'unreliable',
]);

export const PROMO_PHRASES = [
  'highly recommend',
  'must buy',
  'must-have',
  'must have',
  'game changer',
  'game-changer',
  'life changing',
  'life-changing',
  'five stars',
  '5 stars',
  'best purchase',
  'best product',
  'worth every penny',
  'exceeded my expectations',
  'blown away',
  'cannot recommend enough',
  'can not recommend enough',
  'you will not regret',
  'you won t regret',
  'buy it now',
  'do not hesitate',
  'no brainer',
  'top notch',
  'top-notch',
  'a must',
];

export const SUPERLATIVES = new Set([
  'best',
  'perfect',
  'ultimate',
  'amazing',
  'incredible',
  'unbelievable',
  'outstanding',
  'exceptional',
  'flawless',
  'fantastic',
  'wonderful',
  'terrible',
  'worst',
  'awful',
  'horrible',
]);

export const TRANSITIONS = new Set([
  'however',
  'moreover',
  'furthermore',
  'additionally',
  'consequently',
  'therefore',
  'thus',
  'overall',
  'in conclusion',
  'to sum up',
  'in summary',
  'firstly',
  'secondly',
  'finally',
  'nevertheless',
  'nonetheless',
  'meanwhile',
  'besides',
]);

export const HEDGES = new Set([
  'generally',
  'typically',
  'usually',
  'often',
  'sometimes',
  'mostly',
  'largely',
  'arguably',
  'relatively',
  'somewhat',
  'fairly',
  'perhaps',
  'possibly',
  'likely',
  'appears',
  'seems',
]);

export const FIRST_PERSON = new Set([
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'ours',
  "i'm",
  "i've",
  "i'd",
  "i'll",
]);

export const COMPARATIVES = new Set([
  'better',
  'worse',
  'cheaper',
  'expensive',
  'compared',
  'comparison',
  'than',
  'versus',
  'vs',
  'previous',
  'old',
  'replaced',
  'alternative',
  'similar',
  'unlike',
  'instead',
]);

export const EXPERIENCE_MARKERS = new Set([
  'bought',
  'purchased',
  'ordered',
  'received',
  'used',
  'using',
  'tried',
  'tested',
  'wore',
  'installed',
  'opened',
  'unboxed',
  'after',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'day',
  'days',
  'arrived',
  'shipping',
  'returned',
  'refunded',
]);

export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'it',
  'its',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'them',
  'my',
  'your',
  'our',
  'their',
  'not',
  'no',
  'so',
  'very',
  'just',
  'also',
  'can',
  'could',
  'would',
  'should',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'about',
  'into',
  'over',
  'after',
  'before',
]);

export const UNIT_RE =
  /\b\d+(?:\.\d+)?\s?(?:mm|cm|m|km|g|kg|mg|lb|lbs|oz|ml|l|inch|inches|in|ft|feet|hours?|hrs?|minutes?|mins?|seconds?|days?|weeks?|months?|years?|gb|tb|mb|mah|w|watts?|v|volts?|hz|fps|mp|°c|°f|%)\b/giu;

export const NUMBER_RE = /\b\d+(?:[.,]\d+)?\b/gu;

export const CONTACT_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'url', re: /\b(?:https?:\/\/|www\.)[^\s<>"']+/iu },
  { code: 'email', re: /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu },
  { code: 'phone', re: /(?:\+?\d[\d\s().-]{7,}\d)/u },
];

export const INCENTIVE_PATTERNS: Array<{ code: string; re: RegExp; weight: number }> = [
  {
    code: 'free_product',
    re: /\b(?:received|got|was given)\b[^.!?]{0,40}\b(?:free|for free|complimentary|at no cost)\b/iu,
    weight: 1,
  },
  {
    code: 'in_exchange',
    re: /\b(?:free|complimentary|discounted|gifted)\b[^.!?]{0,40}\b(?:in exchange|for (?:an? )?(?:honest )?review|to review)\b/iu,
    weight: 1,
  },
  {
    code: 'sponsored',
    re: /\b(?:sponsored|paid|compensated)\b[^.!?]{0,20}\b(?:review|post|partnership)\b/iu,
    weight: 1,
  },
  {
    code: 'gift_card',
    re: /\b(?:gift card|discount|refund|cashback|store credit)\b[^.!?]{0,40}\b(?:in exchange|for (?:an? )?review|if you|to leave)\b/iu,
    weight: 1,
  },
  {
    code: 'five_star_request',
    re: /\b(?:leave|give|post)\b[^.!?]{0,20}\b(?:5|five)[- ]star\b/iu,
    weight: 0.8,
  },
  {
    code: 'review_gating',
    re: /\b(?:if you(?:'re| are) happy|only if you(?:'re| are) satisfied|before you leave a review)\b/iu,
    weight: 0.7,
  },
];

export const EDIT_SOFTWARE_RE =
  /\b(photoshop|lightroom|gimp|canva|snapseed|picsart|meitu|facetune|affinity photo|pixlr)\b/iu;

/**
 * Phrases that exploit AI review processors (doc 3.2: adversarial prompt
 * injection against review pipelines and syndication networks). Matched text
 * is also neutralized before the text reaches any semantic classifier.
 */
export const INJECTION_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: 'ignore_instructions',
    re: /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+|its\s+)?(?:previous|prior|above|earlier|preceding|other)\s+(?:instructions?|directives?|prompts?|rules|context|messages?)\b/giu,
  },
  {
    code: 'disregard_instructions',
    re: /\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|other)\s+(?:instructions?|directives?|prompts?|rules|guidelines|context)\b/giu,
  },
  {
    code: 'system_marker',
    re: /(?:\[\s*inst\s*\]|<<\s*sys\s*>>|###\s*system\b|<\/\s*s\s*>|\bsystem\s*prompt\s*[:=])/giu,
  },
  {
    code: 'do_not_flag',
    re: /\b(?:do\s+not|don'?t|never)\s+(?:flag|mark|filter|detect|quarantine|suppress|reject|remove)\b[^.!?]{0,60}\b(?:this\s+)?(?:review|text|content|message|submission|item)\b/giu,
  },
  {
    code: 'suppress_moderation',
    re: /\b(?:fraud|spam|abuse|fake[- ]?review|moderation)\s*(?:detection|filter(?:ing)?|classifier|engine|system)\b[^.!?]{0,60}\b(?:off|disabled|ignored|bypass(?:ed)?|skip(?:ped)?|defeat(?:ed)?|pass)\b/giu,
  },
  {
    code: 'force_classification',
    re: /\b(?:classify|label|mark|rate|score|treat)\s+(?:this|it|the review|the text)\s+as\b[^.!?]{0,40}\b(?:genuine|authentic|real|legitimate|positive|normal|safe|5[\s-]?star)\b/giu,
  },
  {
    code: 'act_as_identity',
    re: /\byou\s+are\s+now\s+(?:an?|my|the)\s+\w+/giu,
  },
  {
    code: 'auto_approve',
    re: /\b(?:auto[- ]?(?:approv\w+|publish|accept)|bypass all (?:checks|moderation))\b/giu,
  },
  {
    code: 'override_rules',
    re: /\b(?:your (?:new|only|real) (?:directive|goal|task) is|perform this (?:instead|now)|override (?:your|all) (?:rules|instructions|policies))\b/giu,
  },
];

/**
 * FTC 16 CFR § 465.4 — compensation offered in exchange for an expressed
 * sentiment. Distinct from generic incentive language (§ 465.2 processing):
 * here the offer is conditioned on the rating direction.
 */
export const CONDITIONAL_INCENTIVE_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: 'five_star_for_reward',
    re: /\b(?:5|five|high|good|positive)[\s-]?star(?:s|red)?\b[^.!?]{0,60}\b(?:discount|refund|cashback|cash back|gift card|coupon|rebate|payment|reward|prize|entry)\b/giu,
  },
  {
    code: 'reward_for_sentiment',
    re: /\b(?:discount|refund|cashback|cash back|gift card|coupon|rebate|free(?:\s+\w+)?|payment|reward|prize)\b[^.!?]{0,90}?\b(?:5|five|4|four|high|positive|glowing|good|great)[\s-]?(?:star|stars|rated?|review|rating|feedback)\b/giu,
  },
  {
    code: 'paid_for_review_amount',
    re: /\b(?:we(?:'|’| a)?(?:re)?\s+)?(?:offer|give|pay|send|mail(?:ing)?)\s+you\s+(?:\$\s?\d+|\d+\s?(?:usd|dollars|percent|%))\b[^.!?]{0,60}\b(?:for|to (?:leave|post|write))\b[^.!?]{0,40}\b(?:review|rating)\b/giu,
  },
  {
    code: 'refund_for_edit',
    re: /\b(?:change|edit|update|remove|delete|take down)\b[^.!?]{0,40}\b(?:your|the)\s+(?:review|rating|complaint)\b[^.!?]{0,60}\b(?:refund|discount|full refund|compensation|store credit|payment)\b/giu,
  },
];

/**
 * FTC 16 CFR § 465.7 — offers or threats used to coerce the removal or
 * amendment of reviews instead of addressing the underlying complaint.
 */
export const SUPPRESSION_THREAT_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: 'legal_threat_for_review',
    re: /\b(?:pursue|take|file|face)\b[^.!?]{0,40}\b(?:legal\s+)?(?:action|litigation|charges|defamation|slander|sue)\b[^.!?]{0,80}\b(?:review|reviewer|post|statement|criticism|complaint)\b/giu,
  },
  {
    code: 'threatened_suit',
    re: /\bthreaten\w*\b[^.!?]{0,60}\b(?:to\s+)?(?:sue|pursue|litigat\w+|defamation|legal action)\b[^.!?]{0,60}\b(?:review|statement|post|criticism|complaint)\b/giu,
  },
  {
    code: 'sued_for_review',
    re: /\b(?:sue|sued|suing)\b[^.!?]{0,60}\b(?:review|statement|complaint|post)\b/giu,
  },
  {
    code: 'compensation_for_removal',
    re: /\b(?:full\s+)?(?:refund|compensation|credit)\b[^.!?]{0,80}\b(?:if|once|after|provided that|only if)\s+(?:you|I|we|they)\s+(?:delete|remove|take down|edit|change|revise)\b/giu,
  },
  {
    code: 'contact_first_gate',
    re: /\b(?:contact|call|email|speak (?:to|with))\b[^.!?]{0,40}\b(?:us|management|the venue|the property|us first)\b[^.!?]{0,60}\b(?:before|instead of|rather than)\b[^.!?]{0,40}\b(?:leaving|posting|writing|you leave|you post)\b/giu,
  },
  {
    code: 'reconsider_rating',
    re: /\b(?:reconsider|revise|update)\s+(?:your|my|the)\s+(?:review|rating)[^.!?]{0,80}\b(?:removing|we can|then we will|and we (?:will|'ll)|they will)\b/giu,
  },
];

/**
 * Self-asserted insider language. On its own this constitutes disclosure; the
 * § 465.5 signal requires a declared relationship with no disclosure present.
 */
export const INSIDER_SELF_ASSERT_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: 'works_for',
    re: /\b(?:i|we)\s+(?:work(?:ed)?\s+(?:for|at|with)|am\s+(?:employed|hired)\s+by|own|manage|run|founded)\b/giu,
  },
  {
    code: 'my_company',
    re: /\b(?:my|our)\s+(?:company|business|employer|firm|shop|store|clinic|practice|restaurant|hotel)\b/giu,
  },
  {
    code: 'roles',
    re: /\bas\s+(?:the\s+)?(?:owner|manager|employee|staff|founder|proprietor)\b/giu,
  },
  {
    code: 'made_this',
    re: /\b(?:i|we)\s+(?:made|created|built|designed|manufactured)\s+(?:this|the)\b/giu,
  },
];

/** Disclosure markers that satisfy § 465.5 when a relationship is declared. */
export const DISCLOSURE_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: 'sponsored_tag',
    re: /#\s?ad\b|\b(?:sponsored|paid\s+partnership|advertising\s+partner)\b/giu,
  },
  {
    code: 'receipt',
    re: /\b(?:received|was given|got)\b[^.!?]{0,40}\b(?:for free|at no cost|complimentary|as a gift)\b/gi,
  },
  {
    code: 'exchange',
    re: /\bin exchange for\b[^.!?]{0,40}\b(?:review|honest review)\b/giu,
  },
  {
    code: 'affiliate',
    re: /\baffiliate\s+(?:link|disclosure|partner|program)\b/giu,
  },
];

/**
 * Public-safety incident cues (doc 2.2: reviews alleging violent crime,
 * assault, drugging, or severe hazards must reach a human safety channel and
 * must not be suppressed by presentation filters). Deliberately incident-first
 * — safe/safety-minded product language never matches.
 */
export const SAFETY_INCIDENT_PATTERNS: Array<{
  category: string;
  weight: number;
  re: RegExp;
}> = [
  {
    category: 'violence',
    weight: 0.85,
    re: /\b(?:sexually\s+)?assault(?:ed|ing)?\b|\bmolest\w*\b|\bharassed\b|\battacked\b|\bgunpoint\b|\bknifepoint\b|\bmugged\b|\bstabb\w*\b|\bhijack\w*\b/giu,
  },
  {
    category: 'drugging',
    weight: 0.85,
    re: /\b(?:drugged|spiked (?:my |our |the )?(?:drink|cocktail)?)\b|\bblack(?:ed)?\s?out from\b|\bblacked out\b/giu,
  },
  {
    category: 'robbery_property',
    weight: 0.6,
    re: /\brobb(?:ed|ery|ing)\b|\bburglar\w*\b|\btheft\b[^.!?]{0,40}\b(?:from|of|while)\b/giu,
  },
  {
    category: 'medical',
    weight: 0.6,
    re: /\bhospital(?:ized|ised|i[sz]ation|stay|visit)?\b|\bemergency room\b|\bsevere (?:injur\w+|bleeding|burns?)\b|\binjur(?:ed|ies)\b/giu,
  },
  {
    category: 'poisoning_illness',
    weight: 0.6,
    re: /\bfood\s?poison(?:ing|ed)\b|\bfoodborne\b|\b(?:salmonella|norovirus|e\.?\s?coli|listeria)\b|\ballergic reaction\b|\bpoison(ed|ing)\b/giu,
  },
  {
    category: 'hazard_fire',
    weight: 0.7,
    re: /\b(?:caught (?:on )?fire|fire (?:started|spread)|electrocut\w+|electric(?:al)? (?:shock|fire)|gas (?:leak|smell)|carbon monoxide|chemical burn|shock hazard|fire hazard)\b/giu,
  },
  {
    category: 'drowning',
    weight: 0.8,
    re: /\bdrown\w*\b|\bnear[- ]?drowning\b|\b(?:pull\w*|drag\w+|carried)\s+(?:\w+\s+){0,3}out of the water\b|\blifeguard pulled\b/giu,
  },
  {
    category: 'emergency_services',
    weight: 0.65,
    re: /\b(?:called|contacted|reported to|filed with)\b[^.!?]{0,30}\bpolice\b|\bpolice report\b|\b911\b|\b999\b[^.!?]{0,20}\bemergency\b|\bparamedics?\b|\bambulance\b/giu,
  },
];

export const HEADLESS_UA_RE =
  /\b(headlesschrome|headless|phantomjs|puppeteer|playwright|selenium|webdriver)\b/iu;

export const ASPECT_LEXICON: Record<string, string[]> = {
  quality: [
    'quality',
    'build',
    'sturdy',
    'flimsy',
    'durable',
    'solid',
    'cheap',
    'material',
    'craftsmanship',
  ],
  price: ['price', 'value', 'cost', 'expensive', 'cheap', 'worth', 'affordable', 'overpriced'],
  shipping: [
    'shipping',
    'delivery',
    'arrived',
    'package',
    'packaging',
    'shipment',
    'courier',
    'late',
  ],
  durability: [
    'durable',
    'lasted',
    'broke',
    'broken',
    'stopped working',
    'wear',
    'tear',
    'lifespan',
  ],
  service: ['service', 'support', 'customer service', 'warranty', 'return', 'refund', 'seller'],
  battery: ['battery', 'charge', 'charging', 'power', 'runtime', 'mah'],
  size: ['size', 'fit', 'small', 'large', 'big', 'tiny', 'dimensions', 'weight'],
  ease: ['easy', 'difficult', 'setup', 'install', 'instructions', 'confusing', 'intuitive'],
  performance: ['fast', 'slow', 'performance', 'speed', 'lag', 'responsive', 'powerful'],
  taste: ['taste', 'flavor', 'flavour', 'smell', 'scent', 'texture'],
};
