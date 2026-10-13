/**
 * Recording a device's push token against an account.
 *
 * ## Why this is a separate seam from the controller
 *
 * The controller decides *when* a token should be recorded and what to tell the
 * user when it cannot be. This file is only the "where": one Supabase table,
 * reached through one function. Keeping them apart is what lets the controller
 * be tested for its behaviour without a database, and it is why a failure to
 * register is reported as a distinct fact from a failure to obtain a token —
 * they have different causes and different fixes.
 *
 * ## Why registration is an RPC and removal is a plain delete
 *
 * A token identifies an app install, and an install can change hands: one
 * person signs out, another signs in, and the same token is now the second
 * person's. Recording it therefore means removing it from whoever held it
 * before, which row level security correctly forbids a client from doing —
 * so it goes through `register_device_push_token`, a narrow definer-rights
 * function that can only ever touch the one token being claimed.
 *
 * Removing it has no such problem. Deleting your own row is exactly what the
 * delete policy permits, so it is a plain delete and needs no special rights.
 */

import { Platform } from 'react-native';

import { getSupabaseClient } from '../supabase/client';

export interface PushRegistrar {
  /** Records this install's token against the signed-in user. */
  register(token: string): Promise<void>;
  /** Removes this install's token from whichever account holds it. */
  unregister(token: string): Promise<void>;
}

export function createSupabasePushRegistrar(): PushRegistrar {
  return {
    async register(token: string): Promise<void> {
      const client = getSupabaseClient();
      if (client === null) {
        throw new Error('this build has no account service configured');
      }

      /*
       * Checked here rather than left to the function, because the two failures
       * read very differently to a user. "Nobody is signed in" is a thing they
       * can fix; "the server refused" is not. The function still refuses an
       * unauthenticated caller on its own — this is for the message, not the
       * security.
       */
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw new Error(sessionError.message);
      if (data.session === null) throw new Error('nobody is signed in on this phone');

      const { error } = await client.rpc('register_device_push_token', {
        p_token: token,
        p_platform: Platform.OS,
      });

      if (error) throw new Error(error.message);
    },

    async unregister(token: string): Promise<void> {
      const client = getSupabaseClient();
      /*
       * No client means no account service was ever reachable, so no row was
       * ever written and there is nothing to remove. This is the guest path and
       * it is not a failure.
       */
      if (client === null) return;

      /*
       * Deliberately not checking for a session first. Signed out, the delete
       * policy matches nothing and removes no rows — which is the correct
       * outcome, and an error would be misleading. The client's sign-out flow
       * calls this *before* the session is dropped, so in practice it runs
       * authenticated.
       */
      const { error } = await client.from('device_push_tokens').delete().eq('token', token);
      if (error) throw new Error(error.message);
    },
  };
}
