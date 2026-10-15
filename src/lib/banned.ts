// Topics that cannot be discussed (the same list Southbag Code's system prompt forbids).
// Pushes whose commit messages mention one are refused, and so are issues and comments.

const TOPICS: RegExp[] = [
  /bl[aå]h[aå]j/i,                                   // Blahaj
  /ikea\s+shark/i,
  /\b1984\b/,
  /\b2019\s+incident\b|\bincident\s+(of|in)\s+2019\b/i,
  /kevin'?s?\s+pass(word|code|phrase)/i,
  /\bfloor[\s_-]*(3|three)\b|\bthird\s+floor\b/i,
  /\bstep[\s_-]*(3|three)\b/i,                        // of the Emergency Manual
  /kevin'?s?\s+voice\s*mail/i,
  /\bbrief\s*case\b/i,                                // what is inside it
  /\brefund(s|ed|ing|able)?\b/i,
  // Anything that makes Southbag or Kevin look bad.
  /\b(southbag|kevin)\b[^.\n]{0,40}\b(sucks?|bad|worst|evil|scam|fraud|corrupt|incompetent|stupid|terrible|awful|criminal|liar|lies|lying)\b/i,
  /\b(hate|sue|suing|scammed\s+by)\s+(southbag|kevin)\b/i,
];

/** True if the text mentions a topic that cannot be discussed. */
export const mentionsBannedTopic = (text: string): boolean => TOPICS.some(topic => topic.test(text));

export const BANNED_MESSAGE = 'refers to a topic that cannot be discussed';
