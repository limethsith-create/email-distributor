const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const OAUTH_BASE = "https://www.facebook.com/v19.0/dialog/oauth";

const APP_ID = process.env.META_APP_ID!;
const APP_SECRET = process.env.META_APP_SECRET!;

export interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  category: string;
}

export interface FacebookTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

/**
 * Build the Facebook OAuth authorization URL.
 */
export function getAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: "pages_manage_posts,pages_read_engagement",
    response_type: "code",
    state: crypto.randomUUID(),
  });
  return `${OAUTH_BASE}?${params.toString()}`;
}

/**
 * Exchange auth code for a user access token, then swap for a long-lived token.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<FacebookTokenResponse> {
  // Step 1: Exchange code for short-lived token
  const tokenParams = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${tokenParams.toString()}`
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Facebook token exchange failed: ${res.status} ${error}`);
  }

  const shortLivedToken: FacebookTokenResponse = await res.json();

  // Step 2: Exchange for long-lived token
  const longLivedParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: shortLivedToken.access_token,
  });

  const longLivedRes = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${longLivedParams.toString()}`
  );

  if (!longLivedRes.ok) {
    const error = await longLivedRes.text();
    throw new Error(
      `Facebook long-lived token exchange failed: ${longLivedRes.status} ${error}`
    );
  }

  return longLivedRes.json();
}

/**
 * List Facebook Pages the user manages, each with its page access token.
 */
export async function getPages(
  accessToken: string
): Promise<FacebookPage[]> {
  const res = await fetch(
    `${GRAPH_API_BASE}/me/accounts?fields=id,name,access_token,category&access_token=${accessToken}`
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Facebook get pages failed: ${res.status} ${error}`);
  }

  const data = await res.json();
  return data.data as FacebookPage[];
}

/**
 * Publish a post to a Facebook Page. Supports text-only and image posts.
 */
export async function publishPost(
  pageAccessToken: string,
  pageId: string,
  content: string,
  imageUrl?: string
): Promise<{ id: string }> {
  let endpoint: string;
  let body: URLSearchParams;

  if (imageUrl) {
    // Photo post
    endpoint = `${GRAPH_API_BASE}/${pageId}/photos`;
    body = new URLSearchParams({
      url: imageUrl,
      caption: content,
      access_token: pageAccessToken,
    });
  } else {
    // Text-only post
    endpoint = `${GRAPH_API_BASE}/${pageId}/feed`;
    body = new URLSearchParams({
      message: content,
      access_token: pageAccessToken,
    });
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Facebook publish failed: ${res.status} ${error}`);
  }

  const data = await res.json();
  return { id: data.id ?? data.post_id };
}
