import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const username = searchParams.get('user');

  if (!username) return NextResponse.json({ error: 'Missing username parameter' }, { status: 400 });
  if (isRateLimited(getClientIp(req), 20, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const [userResult, reposResult] = await Promise.allSettled([
      fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
        headers: { 'User-Agent': 'OSIRIS-Recon' },
        signal: safeAbortTimeout(8000),
      }),
      fetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=5`, {
        headers: { 'User-Agent': 'OSIRIS-Recon' },
        signal: safeAbortTimeout(8000),
      })
    ]);

    if (userResult.status !== 'fulfilled') throw userResult.reason;
    const userRes = userResult.value;
    if (userRes.status === 404) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (!userRes.ok) {
      await releaseResponseBody(userRes);
      throw new Error(`GitHub API HTTP ${userRes.status}`);
    }

    const userData = await userRes.json();
    let reposData: any[] = [];
    if (reposResult.status === 'fulfilled') {
      const reposRes = reposResult.value;
      if (reposRes.ok) reposData = await reposRes.json();
      else await releaseResponseBody(reposRes);
    }

    return NextResponse.json({
      username: userData.login,
      name: userData.name,
      company: userData.company,
      blog: userData.blog,
      location: userData.location,
      email: userData.email,
      bio: userData.bio,
      twitter: userData.twitter_username,
      public_repos: userData.public_repos,
      followers: userData.followers,
      created_at: userData.created_at,
      avatar_url: userData.avatar_url,
      recent_repos: Array.isArray(reposData) ? reposData.map((r: any) => ({ name: r.name, language: r.language, updated: r.updated_at })) : []
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'GitHub lookup failed', detail: error.message }, { status: 502 });
  }
}
