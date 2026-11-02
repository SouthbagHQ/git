import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Southbag Online Banking's Billing entrypoint (lib/banking.ts). */
  BANKING?: import('./lib/banking').BankingBilling;
  [binding: string]: unknown;
}

/** A row of `users`. */
export interface User {
  id: string;
  username: string;
  name: string;
  email: string | null;
  bio: string;
  created_at: number;
  frozen: number;
  frozen_reason: string | null;
  frozen_at: number | null;
  security_question: string | null;
  security_streak: number;
  /** In-memory only (never a column): the central status couldn't be checked this request. */
  central_unavailable?: number;
}

/** A row of `repos`, with the owner's username. */
export interface Repo {
  id: string;
  owner_id: string;
  owner: string;
  name: string;
  description: string;
  default_branch: string;
  network_id: string;
  forked_from: string | null;
  next_number: number;
  stars: number;
  forks: number;
  created_at: number;
  updated_at: number;
}

export type AppEnv = { Bindings: Env; Variables: { user: User | null; flash: string | null; unread: number } };
export type Ctx = Context<AppEnv>;
