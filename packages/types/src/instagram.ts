/**
 * How an Instagram account answers a comment on its posts: once under the
 * post, then once in a DM to the commenter. An empty text skips that reply.
 */
export type CommentReplySettings = {
  enabled: boolean;
  public_text: string;
  private_text: string;
};
