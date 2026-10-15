// Security questions for frozen accounts. Three correct answers in a row unfreeze the account (and
// the account review fee is charged). A wrong answer costs a fee and starts the count again.

import type { Env, User } from '../env';
import { chargeFee } from './fees';
import { aestClock } from './hours';
import { notify } from './notify';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const oneOf = (...answers: string[]) => async (_env: Env, _user: User, answer: string) => answers.map(norm).includes(norm(answer));

const firstRepo = (env: Env, user: User) =>
  env.DB.prepare('SELECT * FROM repos WHERE owner_id = ? ORDER BY created_at LIMIT 1').bind(user.id)
    .first<{ name: string; default_branch: string; stars: number }>();

interface Question {
  text: string;
  check: (env: Env, user: User, answer: string) => Promise<boolean>;
}

export const QUESTIONS: Record<string, Question> = {
  first_repo: {
    text: 'What was the name of your first repository?',
    check: async (env, user, answer) => norm((await firstRepo(env, user))?.name ?? 'none') === norm(answer),
  },
  first_branch: {
    text: 'What was the default branch of your first repository?',
    check: async (env, user, answer) => norm((await firstRepo(env, user))?.default_branch ?? 'none') === norm(answer),
  },
  first_stars: {
    text: 'How many stars does your first repository have?',
    check: async (env, user, answer) => String((await firstRepo(env, user))?.stars ?? 0) === norm(answer),
  },
  signup_day: {
    text: 'On what day of the week did you open your Southbag Git account?',
    check: async (_env, user, answer) => norm(answer).startsWith(
      ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][aestClock(user.created_at / 1000).day].slice(0, 3)),
  },
  fees_month: {
    text: 'How much have you paid in fees this calendar month, to the cent?',
    check: async (env, user, answer) => {
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const row = await env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM charges WHERE user_id = ? AND status = 'charged' AND created_at >= ?`)
        .bind(user.id, start.getTime()).first<{ total: number }>();
      const given = Math.round(Number(answer.replace(/[$,\s]/g, '')) * 100);
      return given === row?.total;
    },
  },
  ceo: { text: 'What is the name of the Chief Executive Officer?', check: oneOf('kevin') },
  pile: { text: 'Who maintains The Pile?', check: oneOf('kevin') },
  merge_conflicts: { text: 'Who resolves merge conflicts?', check: oneOf('kevin') },
  phone: {
    text: 'Which telephone does Kevin use to make calls?',
    check: async (_env, _user, answer) => /ip ?355|soundpoint/.test(norm(answer).replace(/\s/g, ' ')),
  },
  briefcase: { text: "How much does a replica of Kevin's Briefcase cost?", check: oneOf('250', '250 00', '$250', '250 dollars') },
  chair: { text: "Who is permitted to sit in Kevin's chair?", check: oneOf('nobody', 'no one', 'noone', 'none', 'no-one') },
  parking: { text: "Who may park in Kevin's parking spot?", check: oneOf('nobody', 'no one', 'noone', 'none', 'no-one') },
  light: { text: "Is the light in Kevin's office on or off?", check: oneOf('on', 'always on', 'it is on', 'it is always on') },
  issue_year: { text: 'In what year did The Issue occur?', check: oneOf('2019') },
  lake: { text: 'Which lake knows what it did?', check: oneOf('lake burley griffin', 'burley griffin') },
  rack: {
    text: "On which floor is the office's server rack?",
    check: oneOf('there is no floor 3', 'southbag has no floor 3', 'none', 'no floor 3', 'there is no floor three'),
  },
  arrival: { text: 'When did Kevin arrive?', check: oneOf('he was already there', 'nobody remembers', 'no one remembers', 'already there') },
};

const ids = Object.keys(QUESTIONS);

/** A random question id, never the one just asked. */
export function pickQuestion(previous: string | null): string {
  const choices = ids.filter(id => id !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}

export const STREAK_NEEDED = 3;

export async function answerQuestion(env: Env, user: User, answer: string): Promise<{ correct: boolean; unfrozen: boolean }> {
  if (!user.frozen) return { correct: true, unfrozen: true };
  const id = user.security_question && QUESTIONS[user.security_question] ? user.security_question : pickQuestion(null);
  const correct = await QUESTIONS[id].check(env, user, answer);
  if (!correct) {
    await env.DB.prepare('UPDATE users SET security_question = ?, security_streak = 0 WHERE id = ?').bind(pickQuestion(id), user.id).run();
    await chargeFee(env, user, 'security_wrong');
    return { correct: false, unfrozen: false };
  }
  const streak = user.security_streak + 1;
  if (streak >= STREAK_NEEDED) {
    await env.DB.prepare(`UPDATE users SET frozen = 0, frozen_reason = NULL, frozen_at = NULL, security_question = NULL, security_streak = 0 WHERE id = ?`)
      .bind(user.id).run();
    await chargeFee(env, user, 'fraud_review');
    await notify(env, user.id, 'Your account has been reviewed and unfrozen.', '/');
    return { correct: true, unfrozen: true };
  }
  await env.DB.prepare('UPDATE users SET security_question = ?, security_streak = ? WHERE id = ?').bind(pickQuestion(id), streak, user.id).run();
  return { correct: true, unfrozen: false };
}
