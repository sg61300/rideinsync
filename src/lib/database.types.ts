// ============================================================================
// Supabase Database types — mirrors supabase/migrations/0001_foundation.sql.
// ----------------------------------------------------------------------------
// Hand-authored placeholder so branches have typed tables before a Supabase
// project exists. Once it does, REGENERATE and overwrite this file:
//   supabase gen types typescript --local > src/lib/database.types.ts
// Keep the migration as the source of truth; this file follows it.
// ============================================================================

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ---- Enums (mirror the Postgres enum types) --------------------------------
export type MemberRole = "leader" | "co_leader" | "sweep" | "rider";
export type RideStatus = "draft" | "active" | "ended" | "cancelled";
export type MemberStatus = "riding" | "stopped" | "rejoining" | "leaving" | "arrived";
export type EventType =
  | "sos" | "hazard" | "route_change" | "stop" | "rejoin"
  | "leave" | "regroup" | "pitstop" | "separation" | "arrived" | "badge_awarded" | "sos_cancelled";
export type TravelMode = "motorcycle" | "car" | "cycle";
export type FeedbackSentiment = "like" | "dislike" | "can_be_better";
export type StoppageReason = "fuel" | "rest" | "mechanical" | "traffic" | "medical" | "other";
export type JoinRequestStatus = "pending" | "approved" | "rejected";
export type DocumentType = "license" | "permit" | "insurance" | "registration" | "other";
export type Visibility = "pod" | "lead_sweep" | "private";
export type SosKind = "manual" | "auto";
export type AckState = "unseen" | "seen";
export type PitstopKind = "planned" | "dynamic";
export type ConsentPolicy = "tnc" | "privacy" | "medical" | "dpdp";
export type Gender = "male" | "female" | "non_binary" | "prefer_not_to_say";
export type AgeBand = "18_25" | "26_35" | "36_45" | "46_55" | "56_plus";
export type GroupMemberRole = "lead" | "member";

// Helper: a table definition with Row / Insert / Update shapes.
// `Relationships: []` is required by @supabase/supabase-js v2's generics — without
// it the client infers `never` for insert/select/rpc. Regenerating with the
// Supabase CLI produces the real relationships; this keeps the placeholder valid.
type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

// Convenience: mark generated/defaulted columns optional on Insert.
type Timestamps = { created_at: string; updated_at: string };

export interface Database {
  public: {
    Tables: {
      profiles: Table<
        {
          id: string;
          display_name: string;
          first_name: string | null;
          last_name: string | null;
          gender: Gender | null;
          age_band: AgeBand | null;
          phone: string | null;
          avatar_url: string | null;
          is_guest: boolean;
        } & Timestamps,
        {
          id: string;
          display_name?: string;
          first_name?: string | null;
          last_name?: string | null;
          gender?: Gender | null;
          age_band?: AgeBand | null;
          phone?: string | null;
          avatar_url?: string | null;
          is_guest?: boolean;
        }
      >;
      rides: Table<
        {
          id: string; code: string; name: string; leader_id: string;
          city: string | null; start_point: Json | null; destination: Json | null; route: Json | null;
          guidelines: string | null; permits: Json | null; member_capacity: number | null;
          fee_amount: number | null; gps_interval_seconds: number;
          separation_distance_km: number; separation_time_seconds: number;
          default_location_visibility: Visibility; status: RideStatus;
          retention_until: string | null; is_demo: boolean; ended_at: string | null;
          scheduled_start: string | null; scheduled_end: string | null;
          travel_mode: TravelMode;
        } & Timestamps,
        { code: string; name: string; leader_id: string; city?: string | null; start_point?: Json | null;
          destination?: Json | null; route?: Json | null; guidelines?: string | null; permits?: Json | null;
          member_capacity?: number | null; fee_amount?: number | null; gps_interval_seconds?: number;
          separation_distance_km?: number; separation_time_seconds?: number;
          default_location_visibility?: Visibility; status?: RideStatus; retention_until?: string | null;
          is_demo?: boolean; scheduled_start?: string | null; scheduled_end?: string | null; }
      >;
      ride_members: Table<
        {
          id: string; ride_id: string; user_id: string; role: MemberRole; status: MemberStatus;
          location_visibility: Visibility | null; joined_at: string; last_seen_at: string | null;
          reached_home_at: string | null;
        },
        { ride_id: string; user_id: string; role?: MemberRole; status?: MemberStatus;
          location_visibility?: Visibility | null; last_seen_at?: string | null }
      >;
      rider_positions: Table<
        {
          id: number; ride_id: string; user_id: string; lat: number; lng: number;
          heading: number | null; speed: number | null; accuracy: number | null; recorded_at: string;
        },
        { ride_id: string; user_id: string; lat: number; lng: number; heading?: number | null;
          speed?: number | null; accuracy?: number | null; recorded_at?: string }
      >;
      // Hot counterpart to rider_positions (M2, supabase/migrations/0023_latest_positions.sql):
      // one row per (ride_id, user_id), upserted by supabase/functions/positions-ingest.
      // Also read by M3's seed query (useRideChannel.ts) and its broadcast aggregator.
      latest_positions: Table<
        {
          ride_id: string; user_id: string; lat: number; lng: number;
          heading: number | null; speed: number | null; accuracy: number | null;
          recorded_at: string; updated_at: string;
        },
        { ride_id: string; user_id: string; lat: number; lng: number; heading?: number | null;
          speed?: number | null; accuracy?: number | null; recorded_at?: string; updated_at?: string }
      >;
      ride_events: Table<
        { id: string; ride_id: string; user_id: string; type: EventType; payload: Json | null; created_at: string },
        { ride_id: string; user_id: string; type: EventType; payload?: Json | null }
      >;
      event_acknowledgements: Table<
        { id: string; event_id: string; user_id: string; state: AckState; delivered_at: string; seen_at: string | null },
        { event_id: string; user_id: string; state?: AckState; seen_at?: string | null }
      >;
      emergency_contacts: Table<
        { id: string; user_id: string; ordinal: number; name: string; phone: string; relation: string | null; email: string | null; created_at: string },
        { user_id: string; ordinal: number; name: string; phone: string; relation?: string | null; email?: string | null }
      >;
      medical_profiles: Table<
        { user_id: string; blood_type: string | null; allergies: string | null; medications: string | null; notes: string | null; updated_at: string },
        { user_id: string; blood_type?: string | null; allergies?: string | null; medications?: string | null; notes?: string | null }
      >;
      vehicles: Table<
        { id: string; user_id: string; make_model: string; plate: string | null; color: string | null; details: Json | null; created_at: string },
        { user_id: string; make_model: string; plate?: string | null; color?: string | null; details?: Json | null }
      >;
      documents: Table<
        { id: string; user_id: string; type: DocumentType; storage_path: string; verified: boolean; uploaded_at: string },
        { user_id: string; type: DocumentType; storage_path: string; verified?: boolean }
      >;
      consent_records: Table<
        { id: string; user_id: string; policy: ConsentPolicy; version: string; granted_at: string },
        { user_id: string; policy: ConsentPolicy; version: string }
      >;
      route_stops: Table<
        { id: string; ride_id: string; seq: number; name: string; location: Json | null; kind: string | null; created_at: string },
        { ride_id: string; seq: number; name: string; location?: Json | null; kind?: string | null }
      >;
      ride_join_requests: Table<
        { id: string; ride_id: string; user_id: string; status: JoinRequestStatus; requested_at: string; decided_at: string | null; decided_by: string | null },
        { ride_id: string; user_id: string; status?: JoinRequestStatus }
      >;
      // Flow 1 ticket 06 — supabase/migrations/0004_flow1_pillion.sql
      ride_pillion_links: Table<
        { id: string; ride_id: string; pillion_user_id: string; rider_user_id: string; created_at: string },
        { ride_id: string; pillion_user_id: string; rider_user_id: string }
      >;
      user_stats: Table<
        { user_id: string; mode: TravelMode; rides_completed: number; distance_m: number; rides_led: number; xp: number; updated_at: string },
        { user_id: string; mode: TravelMode; rides_completed?: number; distance_m?: number; rides_led?: number; xp?: number }
      >;
      badges: Table<
        { key: string; name: string; description: string | null; icon: string | null; mode: TravelMode | null; threshold: number | null },
        { key: string; name: string; description?: string | null; icon?: string | null; mode?: TravelMode | null; threshold?: number | null }
      >;
      user_badges: Table<
        { id: string; user_id: string; badge_key: string; ride_id: string | null; awarded_at: string },
        { user_id: string; badge_key: string; ride_id?: string | null }
      >;
      user_preferences: Table<
        { user_id: string; haptics: boolean; voice_notifications: boolean; push_notifications: boolean; updated_at: string },
        { user_id: string; haptics?: boolean; voice_notifications?: boolean; push_notifications?: boolean }
      >;
      privacy_settings: Table<
        { user_id: string; medical: Visibility; emergency_contacts: Visibility; location_history: Visibility; updated_at: string },
        { user_id: string; medical?: Visibility; emergency_contacts?: Visibility; location_history?: Visibility }
      >;
      stoppage_reports: Table<
        { id: string; ride_id: string; user_id: string; reason: StoppageReason; voice_note_path: string | null; created_at: string },
        { ride_id: string; user_id: string; reason: StoppageReason; voice_note_path?: string | null }
      >;
      separation_events: Table<
        { id: string; ride_id: string; user_id: string; level: number; distance_km: number | null; seconds_behind: number | null; created_at: string },
        { ride_id: string; user_id: string; level: number; distance_km?: number | null; seconds_behind?: number | null }
      >;
      pitstops: Table<
        { id: string; ride_id: string; created_by: string; kind: PitstopKind; location: Json | null; note: string | null; created_at: string },
        { ride_id: string; created_by: string; kind?: PitstopKind; location?: Json | null; note?: string | null }
      >;
      sos_alerts: Table<
        { id: string; ride_id: string; user_id: string; kind: SosKind; payload: Json | null; triggered_at: string; resolved_at: string | null; resolved_by: string | null; stay_requested_at: string | null; cancelled_at: string | null },
        { ride_id: string; user_id: string; kind: SosKind; payload?: Json | null },
        { resolved_at?: string | null; resolved_by?: string | null; stay_requested_at?: string | null; cancelled_at?: string | null }
      >;
      // Flow 5 (migration 0002_sos.sql) — hand-authored mirror; regenerate later.
      sos_responses: Table<
        { id: string; alert_id: string; ride_id: string; user_id: string; reached_at: string | null; created_at: string },
        { alert_id: string; ride_id: string; user_id: string },
        { reached_at?: string | null }
      >;
      ride_summaries: Table<
        { ride_id: string; total_distance_m: number; total_time_s: number; break_time_s: number; avg_speed: number | null; ended_at: string; riders_total: number; riders_home: number; arrival_unconfirmed: number },
        { ride_id: string; total_distance_m?: number; total_time_s?: number; break_time_s?: number; avg_speed?: number | null; riders_total?: number; riders_home?: number; arrival_unconfirmed?: number }
      >;
      ride_feedback: Table<
        { id: string; ride_id: string; user_id: string; answers: Json | null; sentiment: FeedbackSentiment | null; liked_text: string | null; improve_text: string | null; created_at: string },
        { ride_id: string; user_id: string; answers?: Json | null; sentiment?: FeedbackSentiment | null; liked_text?: string | null; improve_text?: string | null }
      >;
      analytics_events: Table<
        { id: number; user_id: string | null; name: string; props: Json | null; created_at: string },
        { user_id?: string | null; name: string; props?: Json | null }
      >;
      // migration 0015_push_notifications.sql — hand-authored mirror; regenerate later.
      push_subscriptions: Table<
        { id: string; user_id: string; ride_id: string; endpoint: string; p256dh: string; auth: string; created_at: string },
        { user_id: string; ride_id: string; endpoint: string; p256dh: string; auth: string }
      >;
      // migration 0017_groups.sql — hand-authored mirror; regenerate later.
      ride_groups: Table<
        { id: string; name: string; city: string | null; culture: string | null; tagline: string | null; rules: string | null; created_by: string; invite_code: string } & Timestamps,
        { name: string; city?: string | null; culture?: string | null; tagline?: string | null; rules?: string | null; created_by: string; invite_code?: string }
      >;
      ride_group_members: Table<
        { id: string; group_id: string; user_id: string; role: GroupMemberRole; joined_at: string },
        { group_id: string; user_id: string; role?: GroupMemberRole }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      request_join_ride: { Args: { join_code: string }; Returns: string };
      approve_join_request: { Args: { request_id: string }; Returns: string };
      // supabase/migrations/0002_flow1_ride_preview.sql — see RidePreviewJson in models.ts.
      get_ride_preview: { Args: { p_code: string }; Returns: Json };
      is_ride_member: { Args: { rid: string }; Returns: boolean };
      is_ride_leader: { Args: { rid: string }; Returns: boolean };
      // supabase/migrations/0003_flow1_lead_approval.sql — ticket 05.
      decline_join_request: { Args: { p_request_id: string }; Returns: undefined };
      assign_ride_role: { Args: { p_ride_id: string; p_user_id: string; p_role: MemberRole }; Returns: undefined };
      // supabase/migrations/0011_ending.sql (Flow 6).
      close_ride: { Args: { p_ride_id: string }; Returns: undefined };
      reached_home: { Args: { p_ride_id: string }; Returns: undefined };
      // supabase/migrations/0012_flow2_remove_member.sql
      remove_ride_member: { Args: { p_ride_id: string; p_user_id: string }; Returns: undefined };
      // supabase/migrations/0017_groups.sql
      create_ride_group: {
        Args: { p_name: string; p_city: string; p_culture: string; p_tagline: string; p_rules: string; p_co_leads?: string[] };
        Returns: string;
      };
      search_riders: { Args: { p_query: string }; Returns: { id: string; display_name: string; avatar_url: string | null }[] };
      is_group_member: { Args: { gid: string }; Returns: boolean };
      is_group_lead: { Args: { gid: string }; Returns: boolean };
      // supabase/migrations/0019_group_invite.sql
      join_group_by_code: { Args: { p_code: string }; Returns: string };
      // supabase/migrations/0022_raise_sos_alert.sql — M0 correctness hardening.
      raise_sos_alert: { Args: { p_ride_id: string; p_user_id: string; p_payload: Json }; Returns: string };
      // supabase/migrations/0032_sos_cancel.sql — raiser cancels their own SOS.
      cancel_sos_alert: { Args: { p_alert_id: string }; Returns: Database["public"]["Tables"]["sos_alerts"]["Row"] };
    };
    Enums: {
      member_role: MemberRole;
      ride_status: RideStatus;
      member_status: MemberStatus;
      event_type: EventType;
      stoppage_reason: StoppageReason;
      join_request_status: JoinRequestStatus;
      document_type: DocumentType;
      visibility: Visibility;
      sos_kind: SosKind;
      ack_state: AckState;
      pitstop_kind: PitstopKind;
      consent_policy: ConsentPolicy;
      travel_mode: TravelMode;
      feedback_sentiment: FeedbackSentiment;
      group_member_role: GroupMemberRole;
    };
    CompositeTypes: Record<string, never>;
  };
}
