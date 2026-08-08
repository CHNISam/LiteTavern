import type { Dictionary } from './zh-CN';

/**
 * English copy, written for the ecosystem this audience already lives in rather
 * than translated phrase by phrase.
 *
 * Concretely: the vocabulary is SillyTavern's, because that is what these
 * readers know — "character card", "greeting", "example dialogue", "system
 * prompt", "bring your own key" — and the tone is plainer and shorter than the
 * Chinese, which reads as warm rather than terse. Nothing here promises anything
 * the Chinese copy does not.
 */
export const en: Dictionary = {
  common: {
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    send: 'Send',
    delete: 'Delete',
    back: 'Back',
    confirm: 'Confirm',
    retry: 'Try again',
    ok: 'Got it',
    submitting: 'Submitting…',
    optional: 'optional'
  },

  language: {
    label: 'Language',
    description: 'Interface language and wording',
    ariaLabel: 'Interface language'
  },

  chrome: {
    appName: 'Messages',
    modelService: 'Models',
    settings: 'Settings',
    signIn: 'Sign in',
    account: 'Account',
    manageAccount: 'Manage account and sync',
    syncWarning: 'Sync problem',
    soundOn: 'Turn sound on',
    soundOff: 'Turn sound off',
    memoriesTitle: (name: string) => `Memories with ${name}`
  },

  contacts: {
    newCharacter: 'New character',
    emptyTitle: 'No characters yet',
    emptyBody: 'Create one below, or import a character card from Settings',
    waitingMessage: 'No messages yet',
    emptyStateTitle: 'Waiting for the first message',
    emptyStateBody:
      'Start with “New character” on the left, or import an existing card from Settings → Import and migrate.'
  },

  chat: {
    stop: 'Stop',
    stopGeneration: 'Stop generation',
    regenerate: 'Regenerate reply',
    offlineBanner:
      'LiteTavern Cloud is unreachable. Local characters, cached conversations and your own models keep working; anything unsynced will retry once it is back. Nothing has been lost.',
    avatarAlt: (name: string) => `${name}’s avatar`,
    fallbackName: 'the character',
    openProfile: (name: string) => `Open ${name}’s profile`,
    placeholder: (name: string) => `Message ${name}…`,
    firstConversation: 'Say something to get started.',
    scrollToBottom: 'Scroll to latest',
    sendMessage: 'Send message',
    quickReplies: 'Suggested replies',
    configuredQuickReplies: 'My quick replies',
    impersonate: 'Write as me',
    impersonateHint: 'Draft a USER-perspective reply without sending it',
    impersonating: 'Writing…',
    impersonateEmpty: 'No user-perspective reply was available yet.',
    impersonateFailed: 'Could not draft a reply. Please try again.',
    thinkingOfReplies: 'Thinking of a few replies…',
    cloudChecking: 'Checking LiteTavern Cloud…',
    cloudUnavailable:
      'LiteTavern Cloud is temporarily unavailable. Try again later, or connect your own model.',
    cloudUnavailableStatus: 'LiteTavern Cloud unavailable',
    retryCloud: 'Retry',
    connectOwnModelAction: 'Connect your own model',
    noModelAvailable:
      'No model available. Connect your own, or check your LiteTavern Cloud allowance.',
    connectOwnModel: 'Connect your own model',
    viewCloudQuota: 'Check LiteTavern Cloud',
    ownModel: 'Your own model',
    characterProfile: 'Character profile',
    copy: 'Copy',
    copied: 'Copied',
    copyMessage: 'Copy message',
    copiedMessage: 'Copied',
    editMessage: 'Edit message',
    editMessageContent: 'Edit message text',
    deleteMessage: 'Delete this message and later replies',
    deleteMessageConfirm: 'Delete this message and every later reply in this conversation?',
    deleteMessageFailed: 'Could not delete the message. Please try again.',
    swipeGroup: 'Other replies',
    swipePrevious: 'Previous reply',
    swipeNext: 'Next reply',
    swipePosition: (index: number, total: number) => `${index} / ${total}`,
    swipeFailed: 'Could not switch replies. Please try again.',
    sendFailed: 'Could not send. Please try again.',
    regexRemovedInput: 'Regex processing removed the whole input, so it was not sent.',
    regexInputTimeout:
      'A Regex script timed out. The original input was used.',
    localContextFailed: 'Could not prepare the local context.',
    regexOutputTimeout:
      'A Regex script timed out. The model’s original text was kept.',
    byokMissingConfiguration: 'Add one of your own models first.',
    byokMissingKey: 'This browser has no API key for that configuration. Please add it again.'
  },

  profile: {
    backToChat: 'Back to messages',
    edit: 'Edit',
    moreActions: 'More actions',
    updateFromCard: 'Update from a character card',
    exportCard: 'Export character card',
    exportFailed: 'Could not export the character card.',
    deleteCharacter: 'Delete character',
    noSummary: 'This card has no description yet.',
    noPersonality: 'This card has no personality yet.',
    summary: 'Description',
    summaryPlaceholder: 'Appearance, role, background',
    personality: 'Personality',
    personalityHint: 'Separate with commas to show them as tags, e.g. gentle, resolute, quiet',
    personalityPlaceholder: 'gentle, resolute, quiet',
    editField: (label: string) => `Edit ${label.toLowerCase()}`,
    relationship: 'Where you stand',
    relationshipUpdated: 'Updated automatically after each conversation.',
    relationshipEmpty: (name: string) =>
      `Once you have talked with ${name}, a short summary of your relationship appears here and keeps up with the conversation.`,
    memories: 'Memories',
    memoriesHint: 'Things worth remembering from your conversations',
    memoriesCount: (count: number, name: string) =>
      `${count} ${count === 1 ? 'memory' : 'memories'}, sent to ${name} along with the conversation`,
    memoriesNone: 'Nothing remembered yet',
    persona: 'Who you are here',
    personaHint: 'Pick the persona you play in this conversation',
    worldbooks: 'Linked worldbooks',
    worldbooksHint: 'Choose which lore is matched against this conversation',
    deleteTitle: (name: string) => `Delete “${name}”?`,
    deleteBody:
      'They will disappear from your contacts and the conversation history goes with them. This cannot be undone.',
    deleting: 'Deleting…',
    deleteFailed: 'Could not delete. Please try again.',
    saveFailed: 'Could not save. Please try again.'
  },

  memory: {
    title: 'Memories',
    backToProfile: 'Back to profile',
    purpose: (name: string) =>
      `These are sent to ${name} along with the conversation. Delete one and it stops being used.`,
    loading: 'Loading memories…',
    emptyTitle: 'Nothing remembered yet',
    emptyBody: (name: string) =>
      `After each exchange with ${name}, anything worth remembering long-term is picked out and kept here, then carried into later conversations.`,
    goChat: 'Start chatting',
    addedByYou: 'Added by you',
    addedAutomatically: 'Picked up automatically',
    unconfirmed: 'Unconfirmed',
    deleteAria: (excerpt: string) => `Delete memory: ${excerpt}`,
    deleteTitle: 'Delete this memory?',
    deleteBody: (name: string) =>
      `${name} will no longer carry it into later conversations. This cannot be undone.`,
    kinds: {
      FACT: { label: 'Facts', blurb: 'Things established about you' },
      PREFERENCE: { label: 'Preferences', blurb: 'What you like and dislike' },
      EXPERIENCE: { label: 'Shared history', blurb: 'What you went through together' },
      COMMITMENT: { label: 'Promises', blurb: 'What you agreed on' },
      CORRECTION: { label: 'Corrections', blurb: 'Things you set straight' },
      OTHER: { label: 'Other', blurb: 'Not sorted yet' }
    }
  },

  editor: {
    eyebrow: 'Character',
    createTitle: 'New character',
    editTitle: 'Edit character',
    loading: 'Loading character…',
    name: 'Name',
    namePlaceholder: 'What are they called?',
    sectionPerson: 'Who they are',
    sectionDialogue: 'How they talk',
    description: 'Description',
    descriptionPlaceholder: 'Appearance, role, background',
    personality: 'Personality',
    personalityNote: 'shown on their profile',
    personalityPlaceholder: 'Separate with commas to show them as tags, e.g. gentle, resolute, quiet',
    scenario: 'Scenario',
    scenarioPlaceholder: 'The situation you are both in',
    firstMessage: 'First message',
    alternateGreetings: 'Alternate greetings',
    alternateGreetingsNote: 'one per line',
    exampleMessages: 'Example dialogue',
    exampleMessagesPlaceholder: 'Show how they speak and their tone',
    advanced: 'Advanced',
    systemPrompt: 'System prompt',
    postHistory: 'Post-history instructions',
    tags: 'Tags',
    tagsNote: 'comma separated',
    creator: 'Creator',
    characterVersion: 'Character version',
    creatorNotes: 'Creator notes',
    saveCharacter: 'Save character',
    nameRequired: 'Give the character a name.',
    saveFailed: 'Could not save the character.',
    avatarUploadFailed: (reason: string) =>
      `The character was saved, but the avatar upload failed: ${reason}`,
    avatarUploadRetry: 'Please try again.',
    unappliedFields: (count: number) =>
      `${count} ${count === 1 ? 'field is' : 'fields are'} kept but not in use`,
    compatibility: {
      FORMAL: 'Fully supported',
      COMPATIBLE: 'Compatible',
      PRESERVED: 'Stored only'
    }
  },

  avatar: {
    preview: 'Avatar preview',
    choose: 'Choose avatar',
    chooseShort: 'Choose image',
    replace: 'Replace',
    remove: 'Remove avatar',
    zoom: 'Zoom',
    dropHint: 'Drop or paste an image. It is cropped to a square when you save.',
    dragHint: 'Drag the image to reposition it.',
    tooLarge: 'Images must be under 12 MB.',
    wrongType: 'Choose a JPEG, PNG or WebP image.',
    processFailed: 'Could not process the image.',
    unreadable: 'That image could not be read. Try another JPEG, PNG or WebP file.',
    cropUnsupported: 'This browser cannot crop images.',
    stillTooLarge: 'The cropped avatar is still too large. Try a smaller image.',
    uploadFailed: 'Could not upload the avatar.',
    deleteFailed: 'Could not remove the avatar.'
  },

  settings: {
    title: 'Settings',
    backToSettings: 'Back to settings',
    sections: 'Settings',
    dataTitle: 'Import and migrate',
    dataBody: 'Import character cards, migrate relationships, or export your cloud data',
    dataLead: 'Occasional data work lives here. New characters still start from the contact list.',
    personasTitle: 'Personas',
    personasBody: 'Manage who you play in a story — unrelated to your account details',
    worldbooksTitle: 'Worldbooks',
    worldbooksBody: 'Manage lore entries; they enter the conversation only when matched',
    quickRepliesTitle: 'Quick replies',
    quickRepliesBody: 'Create browser-local buttons for phrases you use often',
    quickRepliesLead: 'These buttons stay in this browser. They are separate from AI-suggested replies.',
    quickRepliesEnabled: 'Show quick replies',
    quickRepliesEnabledBody: 'Display enabled buttons above the message composer',
    quickRepliesBehavior: 'When clicked',
    quickRepliesBehaviorBody: 'Filling first is safer; direct send is available when you want it',
    quickRepliesFill: 'Fill the composer',
    quickRepliesSend: 'Send immediately',
    quickReplyEnabled: (name: string) => `Enable quick reply ${name}`,
    quickReplyLabel: (position: number) => `Quick reply ${position} label`,
    quickReplyMessage: (position: number) => `Quick reply ${position} message`,
    quickReplyLabelPlaceholder: 'Button label',
    quickReplyMessagePlaceholder: 'Message text',
    moveQuickReplyUp: 'Move quick reply up',
    moveQuickReplyDown: 'Move quick reply down',
    deleteQuickReply: 'Delete quick reply',
    addQuickReply: 'Add quick reply',
    feedbackTitle: 'Send feedback',
    feedbackBody: 'Report a problem or suggest a change; page and environment are attached',
    aboutTitle: 'About LiteTavern',
    aboutBody: 'Version, source code, and how to support the project',
    importCard: 'Import a character card',
    importCardBody: 'Create a character from a local JSON or PNG file',
    migrate: 'Migrate a relationship',
    migrateBody: 'Bring a relationship, profile and memories over from another platform',
    exportCloud: 'Export cloud data',
    exportCloudBody: 'Download a copy of this Cloud account’s data',
    appTagline:
      'An open-source AI client where characters, conversations and shared history carry on.',
    version: (version: string) => `Version ${version}`,
    viewSource: 'View the source on GitHub',
    supportHeading: 'Support LiteTavern',
    supportBody:
      'Supporting the project is entirely optional. It does not affect normal use, Cloud sign-up, sync, plans or Alpha access.',
    supportAction: 'Support LiteTavern'
  },

  models: {
    eyebrow: 'Models',
    title: 'Choose who writes the replies',
    statusLabel: 'Model service status',
    cloudBlurb: 'The hosted model service run by LiteTavern',
    checkingCloud: 'Checking LiteTavern Cloud…',
    temporarilyUnavailable: 'Temporarily unavailable',
    quotaAfterRecovery: (available: number) =>
      `${available} left today, available when the service returns`,
    retryCloud: 'Retry',
    connectOwnModelAction: 'Connect your own model',
    inUse: 'In use',
    usingThis: 'Currently in use',
    useCloud: (name: string) => `Use ${name}`,
    useOwnModel: 'Use your own model',
    ownModel: 'Your own model',
    ownModelBlurb: 'Your API key, billed by the provider you chose',
    ownModelEmpty:
      'No provider connected yet. Pick one below — your API key stays on this device.',
    connectedCount: (count: number) =>
      `${count} ${count === 1 ? 'configuration' : 'configurations'}`,
    connectedLabel: 'Connected',
    currentLabel: 'Active',
    keyLocation: 'Key stored',
    keyLocationValue: 'This browser only',
    quotaUsed: 'Used',
    quotaRemaining: (total: number, unit: string) => `of ${total} ${unit} left`,
    quotaMeterLabel: (pool: string) => `${pool} remaining`,
    quotaStale: (name: string) =>
      `${name} is unreachable — this is the last state that synced.`,
    dailyWindow: 'Today’s allowance',
    periodWindow: 'This period’s allowance',
    dailyResets: (day: string) => `Resets at the end of ${day} UTC`,
    periodResets: (moment: string) => `Resets after ${moment}`,
    platformUnavailable: (name: string) => `${name} is unreachable right now.`,
    connectOwnInstead: 'Connect one of your own models below to keep chatting.',
    noQuotaOnAccount: (name: string) => `This account has no ${name} allowance.`,
    searchLabel: 'Search providers',
    searchPlaceholder: 'Search by name or address',
    noMatch: (query: string) => `No provider matches “${query}”.`,
    alreadyConnected: 'Connected',
    regions: {
      CN: 'China-based providers',
      GLOBAL: 'Global providers',
      LOCAL: 'Local models',
      CUSTOM: 'Custom endpoint'
    },
    loadingProviders: 'Loading providers…',
    loadFailed: (reason: string) => `Could not load providers: ${reason}`,
    loadFailedGeneric: 'Could not load providers. Please try again.',
    keysUnaffected: 'Your API keys are untouched — they never leave this browser.',
    emptyCatalogue: 'The provider catalogue is empty. Check the LiteTavern Cloud configuration.',
    backToProviders: 'Back to providers',
    configurationName: 'Name',
    baseUrl: 'Base URL',
    modelId: 'Model ID',
    modelIdPlaceholder: 'Copy it from the provider’s model list',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Stored in this browser only',
    apiKeyOptional: 'Leave empty for a local server',
    privacyNote:
      'The full key is written to this browser’s IndexedDB. The server only forwards it while validating and generating.',
    providerDocs: 'Provider documentation',
    validateAndSave: 'Validate and save',
    validating: 'Checking the connection…',
    validationFailed: 'The connection could not be validated.',
    connectFailed: 'Connection failed.',
    connected: 'Connected. The configuration is saved in this browser.',
    replaceKey: 'Replace key',
    replaceKeyPrompt: 'Enter the new API key (it stays masked after saving)',
    deleteConfiguration: 'Delete configuration',
    keyMissing: 'No key found in this browser',
    anyOpenAiCompatible: 'Any OpenAI-compatible service'
  },

  cloud: {
    providerName: 'LiteTavern Cloud',
    alphaPool: 'Alpha allowance',
    dailyPool: 'Today’s allowance',
    periodPool: 'This period’s allowance',
    replyUnit: 'replies',
    noQuota: (name: string) => `No ${name} allowance`,
    quotaLabel: (
      provider: string,
      dailyRemaining: number,
      dailyLimit: number,
      periodRemaining: number,
      periodLimit: number
    ) =>
      `${provider}: ${dailyRemaining} of ${dailyLimit} left today, ${periodRemaining} of ${periodLimit} left this period`,
    unavailable: 'LiteTavern Cloud is unavailable. Please try again shortly.',
    requestFailed: 'The request failed. Please try again.',
    streamUnsupported: 'This browser does not support streaming responses.',
    modelUnavailable: 'The model service is temporarily unavailable.'
  },

  account: {
    dialogLabel: 'Account and sync',
    eyebrow: 'Provided by LiteTavern Cloud',
    title: 'Account and sync',
    offline:
      'Sync problem: LiteTavern Cloud is unreachable. Below is the last known state. Local data and your own models are unaffected.',
    cloudAccount: 'Cloud account',
    signedIn: 'Signed in',
    signedOut: 'Not signed in',
    syncedData: 'Synced',
    syncedScope: 'Characters, conversations and memories',
    syncOk: 'Syncing normally',
    syncBroken: 'Sync problem',
    syncAfterLogin: 'Sign in to sync across devices',
    notRegistered: 'No account',
    platformQuota: 'Platform allowance',
    alphaStatus: 'Alpha status',
    accountStates: {
      GUEST: 'Guest',
      UNVERIFIED: 'Email not verified',
      REGISTERED: 'Registered',
      ALPHA: 'Alpha active',
      WAITLIST: 'On the waitlist',
      SUSPENDED: 'Suspended'
    },
    alphaCapacity: (remaining: number, total: number) =>
      `${remaining} of ${total} seats left`,
    alphaBatch: (batch: number) => `Batch ${batch}`,
    registrationCopy:
      'Creating a LiteTavern Cloud account syncs characters, conversations and memories across devices. Registering and verifying your email take no seat on their own — a seat is only claimed the first time you actually use a cloud model. Using your own model stays an independent option.',
    appliedAt: 'Waitlisted: ',
    activatedAt: 'Activated: ',
    quotaTodayLabel: 'Platform replies today',
    quotaPeriodLabel: 'Platform replies this period',
    quotaRemainingOf: (available: number, total: number) => `${available} of ${total} left`,
    dailyResetAt: (day: string) => `Resets at the end of ${day} UTC`,
    periodResetAt: (moment: string) => `Resets after ${moment}`,
    register: 'Create a LiteTavern Cloud account',
    connectOwnModel: 'Connect your own model instead',
    signOut: 'Sign out',
    actionFailed: 'That did not work. Please try again.'
  },

  localAssets: {
    cardDataUnreadable: 'Could not read the character card data.',
    cardNameMissing: 'The character card has no character name.',
    pngInvalid: 'This is not a valid PNG character card.',
    pngCorrupt: 'The PNG character card is damaged.',
    legacyAssetsReadFailed:
      'Could not read the old Cloud assets. You can retry the migration later.',
    legacyWorldbooksReadFailed:
      'Could not read the old Cloud worldbooks. You can retry the migration later.',
    legacyWorldbookName: 'Cloud worldbook',
    characterWorldbookName: (characterName: string) =>
      `${characterName} character worldbook`,
    cardExportFailed: 'Could not export the character card.',
    cloudCardUnreadable: 'Could not read the character card returned by Cloud.',
    storageQuotaExceeded:
      'This browser is out of local storage space. Delete some local assets and try again.',
    storageSaveFailed: 'Could not save to this device. Please try again.',
    indexedDbUnsupported:
      'This browser does not support IndexedDB, so local personas and worldbooks are unavailable.',
    defaultUserLabel: 'User',
    personaNameRequired: 'The persona needs a name.',
    personaNotFound: 'The persona no longer exists.',
    personaImportEmpty: 'This file contains no personas to import.',
    worldbookNotFound: 'The worldbook no longer exists.',
    unnamedWorldbook: 'Untitled worldbook',
    worldbookEntryNotFound: 'The worldbook entry no longer exists.',
    importedWorldbookName: 'Imported worldbook',
    worldbookImportEmpty: 'This file contains no worldbook entries to import.'
  },

  persona: {
    panelTitle: 'Personas',
    eyebrow: 'Persona',
    unsupported:
      'The connected service does not support personas yet. Upgrading LiteTavern Cloud enables them.',
    lead:
      'A persona is who you are inside the story: what the character calls you and who they take you for. It is unrelated to your account name, email or plan — only the persona reaches the conversation.',
    loading: 'Loading personas…',
    readFailed: 'Could not load personas. Please try again.',
    readFailedShort: 'Could not load personas.',
    saveFailed: 'Could not save the persona. Please try again.',
    nameRequired: 'Give the persona a name.',
    empty: 'No personas yet. Create one and new conversations will use it automatically.',
    editAria: (name: string) => `Edit persona ${name}`,
    defaultBadge: 'Default',
    noDescription: 'No description yet.',
    setDefaultAria: (name: string) => `Make ${name} the default persona`,
    setDefaultFailed: 'Could not set the default persona.',
    setDefault: 'Make default',
    deleteAria: (name: string) => `Delete persona ${name}`,
    deleteConfirm: (name: string) =>
      `Delete the persona “${name}”? Conversations using it fall back to no persona.`,
    deleteFailed: 'Could not delete the persona.',
    create: 'New persona',
    createTitle: 'New persona',
    editTitle: 'Edit persona',
    nameLabel: 'Name',
    nameAria: 'Persona name',
    descriptionLabel: 'Description',
    descriptionAria: 'Persona description',
    descriptionPlaceholder:
      'Appearance, temperament, background — or how you want characters to see you.',
    save: 'Save persona',
    pickerTitle: 'Persona for this conversation',
    pickerLead: 'Affects this conversation only. New conversations still use your default.',
    switchFailed: 'Could not switch persona. Please try again.',
    none: 'No persona',
    noneHint: 'The character will refer to you in general terms.',
    pickerEmpty: 'No personas yet — create one under Settings → Personas.',
    localOnly: 'Personas stay on this device and are not marked as synced.',
    conversationLocalOnly:
      'This conversation’s choice stays on this device.',
    avatarMissing: 'Avatar missing; using the default avatar',
    runtimeAtDepth: (depth: number, role: string) =>
      `depth ${depth} · ${role}`,
    preservedFields: (count: number) =>
      `${count} unmapped source ${count === 1 ? 'field' : 'fields'} preserved (not currently executed)`
  },

  worldbook: {
    panelTitle: 'Worldbooks',
    unsupported:
      'The connected service does not support worldbooks yet. Upgrading LiteTavern Cloud enables them.',
    backToList: 'Back to worldbooks',
    lead:
      'A worldbook holds lore that does not change. Entries are injected when their keywords match — unlike memories, which record what you and the character actually went through.',
    entriesLead:
      'Only entries whose keywords match, plus always-on entries, reach the conversation. The rest sit here without costing context.',
    loadingBooks: 'Loading worldbooks…',
    loadingEntries: 'Loading entries…',
    readFailed: 'Could not load worldbooks. Please try again.',
    readFailedShort: 'Could not load worldbooks.',
    readEntriesFailed: 'Could not load the worldbook entries.',
    emptyBooks:
      'No worldbooks yet. Importing a character card with a Character Book creates one automatically.',
    emptyEntries: 'This worldbook has no entries yet.',
    openAria: (name: string) => `Open worldbook ${name}`,
    fromCard: 'From card',
    disabledBadge: 'Disabled',
    entryCount: (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`,
    enableAria: (name: string) => `Enable worldbook ${name}`,
    disableAria: (name: string) => `Disable worldbook ${name}`,
    toggleFailed: 'Could not change the worldbook state.',
    enable: 'Enable',
    disable: 'Disable',
    deleteAria: (name: string) => `Delete worldbook ${name}`,
    deleteConfirm: (name: string) =>
      `Delete the worldbook “${name}”? Linked characters lose this lore.`,
    deleteFailed: 'Could not delete the worldbook.',
    createTitle: 'New worldbook',
    nameAria: 'Worldbook name',
    namePlaceholder: 'e.g. White Harbor lore',
    createFailed: 'Could not create the worldbook.',
    create: 'Create',
    addEntry: 'New entry',
    entryTitleLabel: 'Entry title (for your own filing; never sent to the model)',
    entryTitleAria: 'Entry title',
    entryContentLabel: 'Entry content',
    entryContentAria: 'Entry content',
    entryContentPlaceholder: 'The lore itself. It enters the conversation verbatim when matched.',
    keywordsLabel: 'Trigger keywords (comma separated)',
    keywordsAria: 'Trigger keywords',
    keywordsPlaceholder: 'White Harbor, 白港',
    alwaysOn: 'Always on (no keywords needed; injected every turn)',
    positionLabel: 'Injection position',
    positionAria: 'Injection position',
    positionBeforeChar: 'Before character definition',
    positionAfterChar: 'After character definition',
    orderLabel: 'Order (higher sits closer to the conversation)',
    orderAria: 'Order',
    addEntryAction: 'Add entry',
    addEntryFailed: 'Could not add the entry.',
    untitledEntry: 'Untitled entry',
    alwaysOnBadge: 'Always on',
    enableEntryAria: (title: string) => `Enable entry ${title}`,
    disableEntryAria: (title: string) => `Disable entry ${title}`,
    toggleEntryFailed: 'Could not change the entry state.',
    deleteEntryAria: (title: string) => `Delete entry ${title}`,
    deleteEntryConfirm: 'Delete this piece of lore?',
    deleteEntryFailed: 'Could not delete the entry.',
    linkTitle: (characterName: string) => `${characterName}’s worldbooks`,
    linkLead:
      'Checked worldbooks are matched against conversations with this character. One worldbook can be linked to several characters.',
    linkFailed: 'Could not save the links. Please try again.',
    linkEmpty: 'No worldbooks yet — create one under Settings → Worldbooks.',
    localOnly: 'Worldbooks stay on this device and are not marked as synced.',
    runtimeSummary: (source: string, scanDepth: number, tokenBudget: number) =>
      `On this device only · Source ${source} · Scan depth ${scanDepth} · Budget ${tokenBudget} tokens`,
    entryRuntime: (
      position: string,
      probability: string,
      priority: number
    ) => `${position} · Probability ${probability} · Priority ${priority}`,
    depthRuntime: (depth: number, role: string) =>
      `depth ${depth} · ${role}`,
    probabilityOff: 'off',
    preservedFields: (count: number) =>
      `${count} unmapped source ${count === 1 ? 'field' : 'fields'} preserved (not currently executed)`
  },

  migration: {
    dialogLabel: 'Migrate a relationship',
    eyebrow: 'Character data',
    title: 'Migrate a relationship',
    severity: { FATAL: 'Error', WARNING: 'Warning', INFO: 'Note' },
    copied: 'Copied',
    perLine: (label: string) => `${label} (one per line)`,
    steps: {
      noAccountAccess:
        'LiteTavern never signs into your account on another platform and never scrapes anything on your behalf.',
      exportYourself: 'Export the chat history from the original platform yourself.',
      usePrompt:
        'Copy the migration prompt below and run it through whichever model you already use — ChatGPT, Claude, Gemini — to structure that history.',
      structuredOnly:
        'LiteTavern only accepts the structured JSON that comes out. The raw chat never has to be uploaded here.',
      privacyRisk:
        'The external model you use will see whatever chat content you paste into it. Judge that privacy trade-off yourself.'
    },
    copyPrompt: 'Copy the migration prompt',
    enterImport: 'Continue to import',
    noKeyNeeded:
      'Migration needs no API key: LiteTavern never calls an external model here, and never picks up the bill for the structuring step.',
    jsonOnly:
      'Only .json is accepted. Upload the structured JSON a model produced, not the raw chat history.',
    tooLarge: (sizeKb: number, limitKb: number) =>
      `That file is ${sizeKb} KB, over the ${limitKb} KB limit.`,
    validateFailed: 'Validation failed. Please try again.',
    importFailed: 'Import failed. Please try again.',
    chooseFileAria: 'Choose the migration JSON file',
    choosePlaceholder: 'Choose the structured .json file',
    fileHint: (limitKb: number) =>
      `.json only, up to ${limitKb} KB — not the raw chat history`,
    orPaste: 'Or paste the JSON',
    pasteAria: 'Paste the migration JSON',
    backToIntro: 'Back to instructions',
    validate: 'Validate',
    backToJson: 'Back to the JSON',
    sectionCharacter: 'Character',
    characterName: 'Name',
    characterDescription: 'Description',
    personalityTraits: 'Personality traits',
    speakingStyle: 'Speaking style',
    sectionYou: 'About you',
    preferredName: 'What they should call you',
    userFacts: 'Facts about you',
    userPreferences: 'Your preferences',
    boundaries: 'Boundaries',
    sectionRelationship: 'Relationship',
    relationshipSummary: 'Summary',
    relationshipStage: 'Current stage',
    userAddressing: 'How they address you',
    interactionPatterns: 'Interaction patterns',
    unfinishedThreads: 'Unfinished threads',
    memoriesHeading: (selected: number, total: number) => `Long-term memories (${selected}/${total})`,
    importMemoryAria: (key: string) => `Import memory ${key}`,
    importThis: 'Import this',
    importance: (value: number) => `Importance ${value}`,
    importanceAria: (key: string) => `Importance of memory ${key}`,
    deleteMemoryAria: (key: string) => `Delete memory ${key}`,
    memoryContentAria: (key: string) => `Content of memory ${key}`,
    timeUnknown: 'Time unknown',
    duplicateNote: ' · duplicates an earlier entry',
    noMemories: 'This file has no long-term memories.',
    uncertainHeading: (count: number) => `Uncertain items (${count})`,
    uncertainLead:
      'These are not written to real memories by default. Edit them here, or keep them in the migration record to look at later.',
    uncertainAria: (index: number) => `Uncertain item ${index}`,
    noReason: 'No reason given',
    promoteToMemory: 'Promote to a real memory',
    keepInRecord: 'Keep in the migration record for later',
    nextConfirm: 'Next: confirm the import',
    importTargetHeading: 'Import into',
    createNamed: (name: string) => `Create a new character “${name}”`,
    importIntoExisting: 'One of my existing characters',
    chooseExistingAria: 'Choose an existing character',
    overwriteExisting: 'Also overwrite their name, description and personality with the migrated data',
    noOwnedCharacters: 'You have no characters of your own yet, so a new one will be created.',
    willCreate: 'Create',
    willUpdate: 'Update',
    willReuse: 'Reuse',
    summaryCharacter: (verb: string, name: string) => `${verb} 1 character${name}`,
    summaryMemories: (count: number) => `Write ${count} long-term ${count === 1 ? 'memory' : 'memories'}`,
    summaryRelationship: 'Update 1 relationship summary',
    summaryUncertain: (count: number) => `Keep ${count} uncertain ${count === 1 ? 'item' : 'items'}`,
    summaryConversation: 'Create 1 new LiteTavern conversation',
    noFakeHistory:
      'The old platform\u2019s messages are never forged into LiteTavern history. The new conversation carries a single migration note.',
    backToEdit: 'Back',
    confirmImport: 'Import'
  },

  feedback: {
    open: 'Feedback',
    openAria: 'Send feedback',
    eyebrow: 'Help us check the core experience',
    title: 'Send feedback',
    closeAria: 'Close feedback',
    sent: 'Received — thank you.',
    sentBody:
      'Feedback carries the page, version and runtime environment. It never carries chat content or API keys.',
    done: 'Done',
    kind: 'Type',
    kindUx: 'Something felt wrong',
    kindIdea: 'Suggestion',
    kindOther: 'Other',
    body: 'What happened',
    bodyPlaceholder: 'What happened, and what did you expect instead?',
    contact: 'Contact',
    contactPlaceholder: 'Email, or another way to reach you',
    attachedNote:
      'The current page, app version, browser/device, provider/model and any trace id are attached automatically.',
    sending: 'Sending…',
    send: 'Send feedback',
    failed: 'Could not send the feedback. Please try again.'
  },

  admin: {
    loading: 'Loading the admin console…'
  },

  cloudNotice: {
    byokStillWorks: 'Your own API key still works.',
    byokWhileWaiting: 'You can use your own API key while you wait.',
    seatsAvailable: {
      title: 'First Alpha batch, free to test',
      remaining: (remaining: number, total: number) =>
        `Seats left: ${remaining} / ${total}`,
      howToJoin:
        'Sign up and verify your email; a seat is granted automatically the first time you use a cloud model.',
      periodLimit: (limit: number) => `Each period provides ${limit} cloud replies.`
    },
    capacityFull: {
      title: 'The first Alpha batch is full',
      body: 'Try LiteTavern Cloud once and you will join the waitlist for the second batch.'
    },
    waitlisted: {
      title: 'You are on the waitlist for the second batch.',
      body: 'Once the first batch’s problems are fixed and the service is stable, we will open the next batch of seats.'
    },
    guest: {
      title: 'Sign up and verify your email to try for an Alpha cloud allowance.',
      body: 'As a guest you can explore the bundled demo first.'
    },
    emailUnverified: {
      title: 'Your email is not verified yet',
      body: 'Verify your email to try the cloud models. The verification link was sent to the address you signed up with.'
    },
    suspended: {
      title: 'This account is suspended',
      body: 'This account cannot use LiteTavern Cloud models at the moment. If you think that is a mistake, tell us through the feedback form.'
    },
    dailyExhausted: {
      title: 'Today’s cloud allowance is used up',
      body: 'Today’s cloud allowance is used up; it comes back with the next UTC day.',
      resetsAt: (day: string) =>
        `Today’s cloud allowance is used up. It resets at the end of ${day} UTC.`
    },
    periodExhausted: {
      title: 'This period’s cloud allowance is used up',
      body: 'This period’s cloud allowance is used up; it comes back when the next period starts.',
      resetsAt: (moment: string) =>
        `This period’s cloud allowance is used up. It resets after ${moment}.`
    },
    concurrent: {
      title: 'A reply is already being generated',
      body: 'Wait for that reply to finish before sending the next one.'
    },
    providerUnavailable: {
      title: 'The model provider is temporarily unavailable',
      body: 'This is a temporary failure — try again shortly. Nothing was deducted from your allowance.'
    },
    platformNotConfigured: {
      title: 'Cloud models are not enabled here',
      body: 'LiteTavern Cloud models are not enabled in this environment, so cloud replies do not work here. Nothing was deducted from your allowance. Tell us through the feedback form if you need them.'
    },
    disclaimer:
      'LiteTavern Cloud Alpha is still a test. Allowances, models and cloud rules may change based on real costs, stability and what the test shows.'
  },

  auth: {
    challengeRequired: 'Complete the verification check first.',
    challengeFailed: 'Verification failed. Please try again.',
    challengeUnavailable: 'This deployment has no verification widget configured, so sign-in is unavailable.',
    eyebrow: 'LiteTavern Cloud account',
    dialogLabel: 'Sign in or create a LiteTavern Cloud account',
    signInOrUp: 'Sign in or sign up',
    enterCode: 'Enter the code',
    lead:
      'Enter your email. An existing account signs straight in; a new one is created after verification and syncs characters, conversations and memories. Whether you get an Alpha cloud allowance is decided by the server.',
    email: 'Email',
    codeSentTo: (masked: string) => `We sent a code to ${masked}`,
    codeLabel: '6-digit code',
    sendCode: 'Send code',
    verify: 'Verify and continue',
    changeEmail: 'Use another email',
    resendCode: 'Resend the code',
    resendIn: (seconds: number) => `Resend in ${seconds}s`,
    invalidEmail: 'Enter a valid email address.',
    rateLimited: 'Too many requests. Please wait a moment.',
    deliveryFailed: 'We could not send the verification email. Please try again.',
    codeInvalid: 'That code is not right. Please check and retype it.',
    codeExpired: 'That code has expired. Request a new one.',
    tooManyAttempts: 'Too many attempts. Request a new code.',
    mergeFailed: 'Something went wrong while syncing the account. Please try again.',
    generic: 'That did not work. Please try again.'
  },

  importer: {
    eyebrow: 'Character',
    importTitle: 'Import a character card',
    updateTitle: 'Update from a card',
    chooseFile: 'Choose a card file',
    choosePlaceholder: 'Choose a JSON or PNG character card',
    formatSupport:
      'Character Card V2 / V3 fully supported, Tavern Card V1 compatible, up to 10 MB',
    parsing: 'Parsing safely…',
    avatarPreview: 'Card avatar preview',
    noSummary: 'No description',
    notFilled: 'Empty',
    personality: 'Personality',
    opening: 'Greeting',
    preserved: (fields: string) => `Kept but not in use: ${fields}`,
    confirmImport: 'Import',
    confirmUpdate: 'Update',
    safetyNote:
      'Cards are treated as untrusted files: LiteTavern never runs scripts inside them and never fetches remote addresses they contain.',
    processFailed: 'Could not process the card.',
    parseFailed: 'Could not read the card.',
    importFailed: 'Could not import the card.',
    avatarUnreadable:
      'The character can be imported, but the card’s avatar could not be read — a placeholder will be used.',
    localExtensionsOnly:
      'The card’s worldbook and Regex scripts stay on this device.',
    regexTitle: (count: number) => `Card Regex (${count})`,
    regexAuthorize:
      'Allow these scripts to process input, replies, or worldbook text'
  },

  claim: {
    open: 'Already supported? Claim Founding Supporter',
    title: 'Claim Founding Supporter',
    lead:
      'Paying needs no account and no personal details. The fields below are only for claiming the badge, so we can match it up by hand.',
    nickname: 'Name to show',
    contactType: 'How to reach you',
    contact: 'Contact',
    amount: 'Roughly how much',
    paidAt: 'Roughly when',
    note: 'Message (optional)',
    submit: 'Submit claim',
    submitted: 'Claim submitted — Founding Supporter is granted once verified',
    submittedBody:
      'We check support records by hand and will let you know the result through the contact you left.',
    submitFailed: 'Could not submit. Please try again.',
    contactTypes: { wechat: 'WeChat', email: 'Email', other: 'Other' },
    consent:
      'Your contact is used only to verify the claim, thank you, invite you to tests and send important project notices — never unrelated marketing.',
    nicknameRequired: 'Enter a name to show.',
    contactRequired: 'Enter a way to reach you.',
    amountRequired: 'Enter an amount greater than 0.',
    paidAtRequired: 'Pick roughly when you paid.',
    consentRequired: 'Please agree to how your contact is used.'
  },

  support: {
    documentTitle: 'Support LiteTavern',
    eyebrow: 'VOLUNTARY SUPPORT',
    heroTitle: 'Support LiteTavern’s development',
    heroLead: 'LiteTavern is a free, open-source AI client and web tool.',
    heroBody:
      'Support turns into a steadier service, faster updates, and more of what comes next.',
    usesTitle: 'Where support goes',
    uses: {
      infraTitle: 'Servers and infrastructure',
      infraBody: 'Keeping the service up whenever you open it.',
      modelTitle: 'Model calls and performance',
      modelBody: 'A larger model allowance, with less waiting and fewer limits.',
      domainTitle: 'Domains and essentials',
      domainBody: 'Domain, certificates and CDN, so access stays fast and safe.',
      devTitle: 'Ongoing development',
      devBody: 'New features, fixes and long-term maintenance.'
    },
    methodsTitle: 'How to support',
    cadenceMonthly: 'Monthly',
    thanksTitle: 'What you get back',
    thanks: {
      voiceTitle: 'Heard first',
      voiceBody: 'Questions and suggestions from supporters get read and answered first.',
      rememberTitle: 'Credited if you want',
      rememberBody: 'Supporters who want to be named appear in the credits. Anonymous is fine too.'
    },
    notesTitle: 'The fine print',
    notes: {
      voluntaryTitle: 'Entirely optional',
      voluntaryBody: 'Supporting is your call, and every contribution is appreciated.',
      noGateTitle: 'Nothing is gated',
      noGateBody: 'Everything in the open-source part works without supporting.',
      projectTitle: 'Spent on the project',
      projectBody: 'Support goes into building and maintaining LiteTavern.'
    },
    fineprint:
      'A one-off contribution is not the purchase of a Pro plan, and promises no investment, dividend or return. Supporter status is independent of any future plan; badges such as Founding Supporter are not granted automatically and will be designed separately.',
    suggestedAmount: 'Suggested',
    suggestedAmountLabel: 'Suggested amount',
    customAmount: 'Custom amount',
    customAmountPlaceholder: 'Other',
    afdian: {
      title: 'Afdian',
      body: 'Monthly support on Afdian, the China-based membership platform. Change or cancel any time.',
      action: 'Support on Afdian',
      unavailable: 'Afdian support is not set up yet'
    },
    sources: {
      githubTitle: 'Thanks for following the open-source work.',
      githubBody: 'What is listed below is what actually works today; routes that are not open yet are left out.',
      websiteTitle: 'Thanks for taking a look at LiteTavern.',
      websiteBody:
        'Pick whichever way suits you. Not supporting changes nothing about what you can use.'
    }
  },

  about: {
    documentTitle: 'About LiteTavern',
    eyebrow: 'ABOUT LITETAVERN',
    title: 'Let characters carry their history forward',
    lead:
      'LiteTavern is an AI character world that keeps evolving. Chat is only the way in: the characters, what you do, the world’s history and what happens next add up to a relationship that continues.',
    supportHeading: 'Support LiteTavern',
    supportBody:
      'The open-source part is free to use. If the project helps you, you can voluntarily cover servers, model calls, domains and ongoing development. Not supporting changes nothing about normal use.',
    supportAction: 'Support LiteTavern'
  },

  publicChrome: {
    backToApp: 'Back to LiteTavern',
    appearance: 'Appearance',
    lightMode: 'Light',
    darkMode: 'Dark',
    footerNote: 'The open-source part of LiteTavern is free to use',
    footerNav: 'Footer navigation',
    aboutLink: 'About LiteTavern',
    supportLink: 'Support LiteTavern'
  }
};
