export type TwitterApiErrorType = 'AUTH_ERROR' | 'QUERY_ID_ERROR' | 'UNKNOWN';

export class TwitterApiError extends Error {
  constructor(
    public readonly type: TwitterApiErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'TwitterApiError';
  }
}

// Twitter web の公開 bearer token（全 web クライアント共通）
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// HomeLatestTimeline の GraphQL query ID
// Twitter 内部 API 変更時は DevTools の Network タブで HomeLatestTimeline リクエストの URL から取得して更新する
// 環境変数で上書き可能
const HOME_TL_QUERY_ID =
  process.env.HOME_TL_QUERY_ID ?? 'K0X1xbCZUjttdK8RazKAlw';

// FavoriteTweet mutation の GraphQL query ID（環境変数で上書き可能）
const FAVORITE_QUERY_ID =
  process.env.FAVORITE_QUERY_ID ?? 'lI07N6Otwv1PhnEgXILM7A';

// UnfavoriteTweet mutation の GraphQL query ID（環境変数で上書き可能）
const UNFAVORITE_QUERY_ID =
  process.env.UNFAVORITE_QUERY_ID ?? 'ZYKSe-w7KEslx3JhSIk5LA';

const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export interface TweetMedia {
  url: string;
  thumbUrl: string;
  type: 'photo' | 'video' | 'animated_gif';
}

export interface TimelineResult {
  tweets: Tweet[];
  cursorTop: string | null;
}

export interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  author: {
    name: string;
    screenName: string;
    avatarUrl: string;
    protected: boolean;
  };
  media: TweetMedia[];
  quotedTweet?: Tweet;
  retweetedBy?: {
    name: string;
    screenName: string;
  };
}

export class TwitterClient {
  private cookieStr: string;
  private ct0: string;

  constructor(authToken: string, ct0: string) {
    this.cookieStr = `auth_token=${authToken}; ct0=${ct0}`;
    this.ct0 = ct0;
  }

  private get commonHeaders() {
    return {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Cookie: this.cookieStr,
      'x-csrf-token': this.ct0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    };
  }

  async likeTweet(tweetId: string): Promise<void> {
    const url = `https://x.com/i/api/graphql/${FAVORITE_QUERY_ID}/FavoriteTweet`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.commonHeaders,
      body: JSON.stringify({
        variables: { tweet_id: tweetId },
        queryId: FAVORITE_QUERY_ID,
      }),
    });

    if (!res.ok) {
      throw new Error(`FavoriteTweet error: ${res.status} ${await res.text()}`);
    }
  }

  async unlikeTweet(tweetId: string): Promise<void> {
    const url = `https://x.com/i/api/graphql/${UNFAVORITE_QUERY_ID}/UnfavoriteTweet`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.commonHeaders,
      body: JSON.stringify({
        variables: { tweet_id: tweetId },
        queryId: UNFAVORITE_QUERY_ID,
      }),
    });

    if (!res.ok) {
      throw new Error(`UnfavoriteTweet error: ${res.status} ${await res.text()}`);
    }
  }

  async fetchHomeTimeline(count = 40, cursor?: string): Promise<TimelineResult> {
    const variables: Record<string, unknown> = {
      count,
      includePromotedContent: true,
      latestControlAvailable: true,
      requestContext: cursor ? 'ptr' : 'launch',
      seenTweetIds: [],
    };
    if (cursor) variables.cursor = cursor;

    const url =
      `https://x.com/i/api/graphql/${HOME_TL_QUERY_ID}/HomeLatestTimeline` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const res = await fetch(url, {
      headers: {
        ...this.commonHeaders,
        'x-twitter-client-language': 'ja',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new TwitterApiError('AUTH_ERROR', `Twitter API returned ${res.status}: ${body}`);
      }
      if (res.status === 400 || res.status === 404) {
        throw new TwitterApiError('QUERY_ID_ERROR', `Twitter API returned ${res.status} (query ID may have changed): ${body}`);
      }
      throw new TwitterApiError('UNKNOWN', `Twitter GraphQL error: ${res.status} ${body}`);
    }

    const data = (await res.json()) as unknown;
    return parseTweets(data);
  }
}

function parseTweets(data: unknown): TimelineResult {
  try {
    const instructions =
      (data as any)?.data?.home?.home_timeline_urt?.instructions ?? [];
    const entries: unknown[] =
      instructions.find((i: any) => i.type === 'TimelineAddEntries')?.entries ?? [];

    const tweets = entries
      .filter((e: any) => (e.entryId as string)?.startsWith('tweet-'))
      .map((e: any) => parseTweetResult(e.content?.itemContent?.tweet_results?.result))
      .filter((t): t is Tweet => t !== null);

    const cursorTopEntry = entries.find(
      (e: any) => (e.content as any)?.cursorType === 'Top',
    );
    const cursorTop = ((cursorTopEntry as any)?.content?.value as string | undefined) ?? null;

    return { tweets, cursorTop };
  } catch {
    return { tweets: [], cursorTop: null };
  }
}

function parseTweetResult(result: any): Tweet | null {
  if (!result) return null;

  const tweet =
    result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  const legacy = tweet?.legacy;
  const userLegacy = tweet?.core?.user_results?.result?.legacy;

  if (!legacy || !userLegacy) return null;

  // リツイートの場合は元ツイートを主体として返し、RTしたユーザーを retweetedBy に添付する
  const retweetedResult = legacy.retweeted_status_result?.result;
  if (retweetedResult) {
    const original = parseTweetResult(retweetedResult);
    if (original) {
      return {
        ...original,
        id: legacy.id_str as string,
        createdAt: legacy.created_at as string,
        retweetedBy: {
          name: userLegacy.name as string,
          screenName: userLegacy.screen_name as string,
        },
      };
    }
  }

  const media: TweetMedia[] = (legacy.extended_entities?.media ?? [])
    .map((m: any): TweetMedia | null => {
      const thumbUrl = m.media_url_https as string | undefined;
      if (!thumbUrl) return null;

      if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = (m.video_info?.variants ?? []) as Array<{ bitrate?: number; url: string }>;
        const withBitrate = variants.filter(v => v.bitrate !== undefined);
        const best = withBitrate.length > 0
          ? withBitrate.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
          : variants[0];
        if (!best?.url) return null;
        return { url: best.url, thumbUrl, type: m.type as 'video' | 'animated_gif' };
      }

      return { url: thumbUrl, thumbUrl, type: 'photo' };
    })
    .filter((m: TweetMedia | null): m is TweetMedia => m !== null);

  // 添付メディアの t.co URL が full_text 末尾に含まれるので除去する
  const mediaTcoUrl = (legacy.extended_entities?.media?.[0]?.url ??
    legacy.entities?.media?.[0]?.url) as string | undefined;
  let text = mediaTcoUrl
    ? (legacy.full_text as string).replace(mediaTcoUrl, '').trim()
    : (legacy.full_text as string);

  // t.co 短縮リンクを expanded_url に展開する
  const urlEntities = (legacy.entities?.urls ?? []) as Array<{
    url: string;
    expanded_url: string;
    display_url: string;
  }>;
  for (const u of urlEntities) {
    text = text.replace(u.url, u.expanded_url);
  }

  return {
    id: legacy.id_str as string,
    text,
    createdAt: legacy.created_at as string,
    author: {
      name: userLegacy.name as string,
      screenName: userLegacy.screen_name as string,
      avatarUrl: userLegacy.profile_image_url_https as string,
      protected: (userLegacy.protected as boolean | undefined) ?? false,
    },
    media,
    quotedTweet:
      parseTweetResult(result.quoted_status_result?.result) ?? undefined,
  };
}
