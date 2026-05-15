/**
 * Predefined CLIP vocabulary presets for zero-shot image tagging.
 *
 * The sidecar's /tag endpoint scores every image against the supplied
 * vocabulary labels using CLIP; only labels above the configured threshold
 * are persisted. Presets here are selected via cfg.tagVocabularyPreset.
 *
 * Vocabulary items should be CLIP-friendly natural language phrases —
 * single concepts score more reliably than multi-clause sentences.
 */

// ---- Adult content preset ---------------------------------------------------
//
// ~200 terms covering body, pose, attire, acts, and scene context.
// Designed to complement the WD14 Danbooru taxonomy: WD14 gives precise
// anime/illustration tags; this CLIP preset gives natural-language captions
// for photographic content.

const ADULT_VOCABULARY = [
    // Nudity / state of dress
    'nude woman',
    'nude man',
    'topless woman',
    'naked body',
    'partial nudity',
    'fully clothed',
    'lingerie',
    'underwear',
    'swimsuit',
    'bikini',
    'thong',
    'corset',
    'stockings',
    'fishnets',
    'high heels',
    'costume',
    'cosplay',

    // Body focus
    'breasts',
    'cleavage',
    'bare chest',
    'exposed midriff',
    'buttocks',
    'legs',
    'feet',
    'hands',
    'back',
    'neck',
    'shoulders',
    'curvy body',
    'athletic body',
    'slim body',
    'busty',
    'muscular',

    // Poses and positions
    'standing pose',
    'sitting pose',
    'lying down',
    'kneeling',
    'bent over',
    'arching back',
    'spreading legs',
    'crossed legs',
    'hands behind head',
    'looking over shoulder',
    'seductive pose',
    'provocative pose',
    'playful pose',
    'confident pose',
    'vulnerable pose',

    // Facial expressions
    'seductive expression',
    'smiling',
    'moaning expression',
    'eyes closed',
    'direct eye contact',
    'biting lip',
    'open mouth',

    // Acts — solo
    'self touching',
    'masturbation',
    'using sex toy',
    'vibrator',
    'dildo',
    'fingering',
    'nipple play',

    // Acts — couples / group
    'kissing',
    'making out',
    'oral sex',
    'blowjob',
    'cunnilingus',
    'sexual intercourse',
    'missionary position',
    'doggy style position',
    'cowgirl position',
    'spooning',
    'anal sex',
    'handjob',
    'threesome',
    'group sex',
    'gang bang',
    'double penetration',
    'sex toys used together',

    // BDSM / fetish
    'bondage',
    'tied up',
    'handcuffs',
    'blindfold',
    'collar and leash',
    'spanking',
    'dominance',
    'submission',
    'latex outfit',
    'leather outfit',
    'role play',
    'feet fetish',
    'stockings fetish',

    // Fluids / explicit detail
    'ejaculation',
    'creampie',
    'facial',
    'cum on body',
    'cum on face',
    'squirting',
    'wet body',
    'oiled body',
    'sweat',

    // Demographics — gender
    'woman',
    'man',
    'transgender woman',
    'transgender man',
    'non-binary person',

    // Demographics — age markers (legal adult)
    'young adult woman',
    'young adult man',
    'mature woman',
    'mature man',
    'older woman',
    'older man',

    // Demographics — body hair
    'shaved pubic area',
    'hairy pubic area',
    'natural body hair',

    // Ethnicity descriptors (neutral)
    'asian woman',
    'black woman',
    'latina woman',
    'white woman',
    'asian man',
    'black man',
    'latino man',
    'white man',

    // Hair styles / colours
    'blonde hair',
    'brunette hair',
    'red hair',
    'black hair',
    'grey hair',
    'long hair',
    'short hair',
    'curly hair',
    'straight hair',
    'pigtails',
    'ponytail',
    'braids',

    // Scene / setting
    'bedroom',
    'bathroom',
    'shower',
    'outdoors',
    'pool',
    'sofa',
    'office',
    'hotel room',
    'car interior',
    'kitchen',
    'studio',
    'dungeon',

    // Lighting / photography style
    'professional photography',
    'amateur photography',
    'selfie',
    'mirror selfie',
    'candid photo',
    'soft lighting',
    'dim lighting',
    'bright lighting',
    'black and white photo',
    'close-up photo',
    'full body shot',
    'portrait',

    // Media type
    'video screenshot',
    'animated gif',
    'illustration',
    'drawing',
    'hentai illustration',
    '3d render',
    'comic panel',

    // Relationship / context
    'couple',
    'lesbian couple',
    'gay couple',
    'interracial couple',
    'amateur couple',
    'professional adult performer',
    'onlyfans style photo',

    // Content rating signals
    'explicit sexual content',
    'softcore content',
    'suggestive content',
    'erotic content',
    'pornographic content',
    'nsfw content',
    'adult content',
];

const TRIMMED_VOCABULARY = [
    'nude woman',
    'nude man',
    'fully clothed',
    'lingerie',
    'bikini',
    'cleavage',
    'athletic body',
    'standing pose',
    'lying down',
    'smiling',
    'kissing',
    'sexual intercourse',
    'bondage',
    'latex outfit',
    'leather outfit',
    'woman',
    'man',
    'outdoors',
    'bedroom',
    'explicit sexual content',
];

// ---- Registry ---------------------------------------------------------------

const _PRESETS = {
    adult: ADULT_VOCABULARY,
    trimmed: TRIMMED_VOCABULARY,
};

/**
 * Return the vocabulary array for a named preset, or null if unknown.
 *
 * @param {string} name  Preset name (e.g. 'adult')
 * @returns {string[] | null}
 */
export function getVocabularyPreset(name) {
    if (!name || typeof name !== 'string') return null;
    return _PRESETS[name.toLowerCase()] ?? null;
}

/**
 * List all available preset names.
 * @returns {string[]}
 */
export function listVocabularyPresets() {
    return Object.keys(_PRESETS);
}
