// Everything under /:owner/:repo.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import admin from './repo-admin';
import code from './repo-code';
import issues from './repo-issues';
import merges from './repo-merges';
import requests from './repo-requests';

const app = new Hono<AppEnv>();
app.route('/', requests);
app.route('/', issues);
app.route('/', merges);
app.route('/', admin);
// Last: the code browser's /:owner/:repo/src/* and /:owner/:repo itself.
app.route('/', code);

export default app;
