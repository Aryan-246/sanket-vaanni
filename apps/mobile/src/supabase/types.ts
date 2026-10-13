/**
 * Supabase database and authentication types for Sanket Vaanni.
 */

import type { Session, User } from '@supabase/supabase-js';

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          avatar_url: string | null;
          role: 'user' | 'admin';
          status: 'active' | 'suspended';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          /** A path in the private bucket. The database rejects a full URL. */
          avatar_url?: string | null;
          /**
           * Not writable by a client. A trigger refuses any value other than
           * 'user' unless the write comes from the service role, so listing it
           * here is a description of the row, not an offer.
           */
          role?: 'user' | 'admin';
          status?: 'active' | 'suspended';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          /** Refused for client tokens; see the note above. */
          role?: 'user' | 'admin';
          status?: 'active' | 'suspended';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_preferences: {
        Row: {
          user_id: string;
          sign_profile_id: string;
          target_language_code: string;
          voice_enabled: boolean;
          theme_mode: 'system' | 'dark' | 'light';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          sign_profile_id?: string;
          target_language_code?: string;
          voice_enabled?: boolean;
          theme_mode?: 'system' | 'dark' | 'light';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          sign_profile_id?: string;
          target_language_code?: string;
          voice_enabled?: boolean;
          theme_mode?: 'system' | 'dark' | 'light';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_preferences_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      calibration_profiles: {
        Row: {
          id: string;
          user_id: string;
          side: 'left' | 'right';
          captured_at_ms: number;
          sign_language_id: string | null;
          channels: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          side: 'left' | 'right';
          captured_at_ms: number;
          sign_language_id?: string | null;
          channels: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          side?: 'left' | 'right';
          captured_at_ms?: number;
          sign_language_id?: string | null;
          channels?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'calibration_profiles_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      oled_profiles: {
        /**
         * The shape the database actually has.
         *
         * This previously described an `id` / `left_preset` / `right_preset`
         * table that does not exist, and `sync.ts` was written against that
         * description. The result was cloud sync that failed on every write:
         * wrong column names, a conflict target that matched no constraint, and
         * a JSON string being written into a JSONB column. Both files now
         * describe the real table, and the primary key is `(user_id,
         * profile_id)` rather than anything involving the profile's name — a
         * user may rename a profile, and a rename must not create a second row.
         */
        Row: {
          user_id: string;
          profile_id: string;
          name: string;
          created_at_ms: number;
          updated_at_ms: number;
          left_config: Json;
          right_config: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          profile_id: string;
          name: string;
          created_at_ms: number;
          updated_at_ms: number;
          left_config: Json;
          right_config: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          profile_id?: string;
          name?: string;
          created_at_ms?: number;
          updated_at_ms?: number;
          left_config?: Json;
          right_config?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'oled_profiles_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      user_history: {
        Row: {
          id: string;
          user_id: string;
          entry_id: string;
          text: string;
          profile_id: string;
          source: 'glove' | 'demo';
          created_at_ms: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          entry_id: string;
          text: string;
          profile_id: string;
          source: 'glove' | 'demo';
          created_at_ms: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          entry_id?: string;
          text?: string;
          profile_id?: string;
          source?: 'glove' | 'demo';
          created_at_ms?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_history_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };

      /**
       * Application settings, including maintenance mode.
       *
       * Readable by `anon` as well as `authenticated` — that is the point of it,
       * since maintenance mode has to block a sign-in and a check that runs
       * after authentication cannot. There is no write policy for either role;
       * only the backend, with the service-role key, can change a row, so that a
       * change is always accompanied by an audit record.
       */
      app_settings: {
        Row: {
          key: string;
          value: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          key: string;
          value: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          key?: string;
          value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };

      /**
       * Announcements.
       *
       * Published and unexpired rows are readable by everyone, signed in or not,
       * so an outage notice is visible before sign-in. Drafts are visible only
       * to administrators, through the same policy that already lets them read
       * the user list.
       */
      announcements: {
        Row: {
          id: string;
          title: string;
          body: string;
          severity: 'info' | 'warning' | 'critical';
          published: boolean;
          published_at: string | null;
          expires_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          body: string;
          severity?: 'info' | 'warning' | 'critical';
          published?: boolean;
          published_at?: string | null;
          expires_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          body?: string;
          severity?: 'info' | 'warning' | 'critical';
          published?: boolean;
          published_at?: string | null;
          expires_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      /**
       * The append-only administrative log.
       *
       * Listed here so a client can *read* it where the policy permits. There is
       * deliberately no usable `Insert` or `Update`: the table has no write grant
       * for any client role, and rows are written by the backend with the
       * service-role key. Typing it as writable would describe a capability that
       * does not exist.
       */
      admin_audit_log: {
        Row: {
          id: string;
          actor_id: string | null;
          actor_email: string | null;
          action: string;
          target_type: string;
          target_id: string | null;
          reason: string;
          metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };

      /**
       * Firebase registration tokens, one row per app install.
       *
       * The token is the primary key, so an install can belong to exactly one
       * account at a time — see the migration for why that matters.
       *
       * `Insert` is typed even though a client should use the
       * `register_device_push_token` function instead: a direct insert can only
       * create a row for a token nobody already holds, because RLS refuses the
       * other case. The function is what handles a token changing hands, and it
       * is what the client actually calls.
       */
      device_push_tokens: {
        Row: {
          token: string;
          user_id: string;
          platform: string;
          created_at: string;
          updated_at: string;
          last_seen_at: string;
        };
        Insert: {
          token: string;
          user_id: string;
          platform?: string;
          created_at?: string;
          updated_at?: string;
          last_seen_at?: string;
        };
        /** No update path exists; a row is created or removed. */
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      delete_user_account: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      /**
       * True when the caller holds the admin role and is not suspended.
       *
       * No argument on purpose: the function answers only about the caller, so
       * it cannot be used to ask whether some other account is an administrator.
       */
      is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      /**
       * True when the caller is not suspended.
       *
       * No argument on purpose: the function answers only about the caller, so
       * it cannot be used to ask whether some other account is suspended.
       */
      is_active: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      /**
       * Claims a Firebase registration token for the calling user.
       *
       * Runs with definer rights because claiming a token has to remove any row
       * already holding it, which may belong to another account. It refuses an
       * unauthenticated caller and can only affect the one token named.
       */
      register_device_push_token: {
        Args: { p_token: string; p_platform?: string };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

export type ProfileRow = Database['public']['Tables']['profiles']['Row'];
export type UserPreferencesRow = Database['public']['Tables']['user_preferences']['Row'];
export type CalibrationProfileRow = Database['public']['Tables']['calibration_profiles']['Row'];
export type OledProfileRow = Database['public']['Tables']['oled_profiles']['Row'];
export type UserHistoryRow = Database['public']['Tables']['user_history']['Row'];

/* ----------------------------------------------------------- administration */

/**
 * One row of the append-only administrative log.
 *
 * Rows are written by the backend service and can never be edited or deleted by
 * any client — the table has no UPDATE or DELETE grant. `reason` is mandatory
 * and the database rejects a blank one, so "why" is never missing from an
 * answer about what an administrator did.
 */
export interface AdminAuditRow {
  readonly id: string;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly reason: string;
  readonly metadata: Json;
  readonly created_at: string;
}

/** The maintenance-mode setting, as stored. */
export interface MaintenanceSetting {
  readonly enabled: boolean;
  readonly message: string;
  readonly enabledAt: string | null;
  readonly expectedEndAt: string | null;
}

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';

export interface AnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: AnnouncementSeverity;
  readonly published: boolean;
  readonly published_at: string | null;
  readonly expires_at: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AuthState {
  readonly session: Session | null;
  readonly user: User | null;
  readonly isLoading: boolean;
  readonly isGuest: boolean;
  readonly error: string | null;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface SyncState {
  readonly status: SyncStatus;
  readonly lastSyncedAtMs: number | null;
  readonly pendingChangesCount: number;
  readonly lastError: string | null;
}
