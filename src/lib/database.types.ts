export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          activity_name: string | null
          activity_type: string | null
          aerobic_efficiency: number | null
          average_cadence: number | null
          average_heartrate: number | null
          average_pace: string | null
          average_watts: number | null
          best_efforts: Json | null
          cardiac_decoupling_pct: number | null
          created_at: string | null
          distance_meters: number | null
          elapsed_time_seconds: number | null
          elevation_gain: number | null
          gear_id: string | null
          gear_name: string | null
          id: string
          max_heartrate: number | null
          moving_time_seconds: number | null
          source: string
          start_date: string | null
          start_lat: number | null
          start_lng: number | null
          strava_activity_id: number | null
          suffer_score: number | null
          summary: Json | null
          user_id: string
          weather_data: Json | null
          weather_fetched_at: string | null
          workout_type: number | null
        }
        Insert: {
          activity_name?: string | null
          activity_type?: string | null
          aerobic_efficiency?: number | null
          average_cadence?: number | null
          average_heartrate?: number | null
          average_pace?: string | null
          average_watts?: number | null
          best_efforts?: Json | null
          cardiac_decoupling_pct?: number | null
          created_at?: string | null
          distance_meters?: number | null
          elapsed_time_seconds?: number | null
          elevation_gain?: number | null
          gear_id?: string | null
          gear_name?: string | null
          id?: string
          max_heartrate?: number | null
          moving_time_seconds?: number | null
          source?: string
          start_date?: string | null
          start_lat?: number | null
          start_lng?: number | null
          strava_activity_id?: number | null
          suffer_score?: number | null
          summary?: Json | null
          user_id: string
          weather_data?: Json | null
          weather_fetched_at?: string | null
          workout_type?: number | null
        }
        Update: {
          activity_name?: string | null
          activity_type?: string | null
          aerobic_efficiency?: number | null
          average_cadence?: number | null
          average_heartrate?: number | null
          average_pace?: string | null
          average_watts?: number | null
          best_efforts?: Json | null
          cardiac_decoupling_pct?: number | null
          created_at?: string | null
          distance_meters?: number | null
          elapsed_time_seconds?: number | null
          elevation_gain?: number | null
          gear_id?: string | null
          gear_name?: string | null
          id?: string
          max_heartrate?: number | null
          moving_time_seconds?: number | null
          source?: string
          start_date?: string | null
          start_lat?: number | null
          start_lng?: number | null
          strava_activity_id?: number | null
          suffer_score?: number | null
          summary?: Json | null
          user_id?: string
          weather_data?: Json | null
          weather_fetched_at?: string | null
          workout_type?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "activities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          content: string
          created_at: string | null
          external_message_id: string | null
          id: string
          message_type: string | null
          role: string
          strava_activity_id: number | null
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          external_message_id?: string | null
          id?: string
          message_type?: string | null
          role: string
          strava_activity_id?: number | null
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          external_message_id?: string | null
          id?: string
          message_type?: string | null
          role?: string
          strava_activity_id?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string | null
          event_name: string
          id: string
          properties: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          event_name: string
          id?: string
          properties?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          event_name?: string
          id?: string
          properties?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      exercise_library: {
        Row: {
          aliases: string[]
          category: string
          created_at: string | null
          gif_url: string
          id: string
          instructions: string | null
          linq_attachment_id: string | null
          name: string
        }
        Insert: {
          aliases?: string[]
          category: string
          created_at?: string | null
          gif_url?: string
          id?: string
          instructions?: string | null
          linq_attachment_id?: string | null
          name: string
        }
        Update: {
          aliases?: string[]
          category?: string
          created_at?: string | null
          gif_url?: string
          id?: string
          instructions?: string | null
          linq_attachment_id?: string | null
          name?: string
        }
        Relationships: []
      }
      races: {
        Row: {
          course_record_minutes: number | null
          created_at: string | null
          elevation_gain_feet: number | null
          elevation_loss_feet: number | null
          goal: string
          goal_distance_miles: number | null
          goal_time_minutes: number | null
          id: string
          priority: string
          race_altitude_ft: number | null
          race_date: string
          race_name: string | null
          trail_subtype: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          course_record_minutes?: number | null
          created_at?: string | null
          elevation_gain_feet?: number | null
          elevation_loss_feet?: number | null
          goal: string
          goal_distance_miles?: number | null
          goal_time_minutes?: number | null
          id?: string
          priority?: string
          race_altitude_ft?: number | null
          race_date: string
          race_name?: string | null
          trail_subtype?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          course_record_minutes?: number | null
          created_at?: string | null
          elevation_gain_feet?: number | null
          elevation_loss_feet?: number | null
          goal?: string
          goal_distance_miles?: number | null
          goal_time_minutes?: number | null
          id?: string
          priority?: string
          race_altitude_ft?: number | null
          race_date?: string
          race_name?: string | null
          trail_subtype?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "races_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      training_plans: {
        Row: {
          created_at: string | null
          goal: string | null
          id: string
          plan_source: string
          race_date: string | null
          raw_plan_text: string | null
          total_weeks: number
          updated_at: string | null
          user_id: string | null
          weeks: Json
        }
        Insert: {
          created_at?: string | null
          goal?: string | null
          id?: string
          plan_source?: string
          race_date?: string | null
          raw_plan_text?: string | null
          total_weeks: number
          updated_at?: string | null
          user_id?: string | null
          weeks?: Json
        }
        Update: {
          created_at?: string | null
          goal?: string | null
          id?: string
          plan_source?: string
          race_date?: string | null
          raw_plan_text?: string | null
          total_weeks?: number
          updated_at?: string | null
          user_id?: string | null
          weeks?: Json
        }
        Relationships: [
          {
            foreignKeyName: "training_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      training_profiles: {
        Row: {
          coaching_mode: string
          constraints: string | null
          crosstraining_tools: string[] | null
          current_easy_pace: string | null
          current_interval_pace: string | null
          current_tempo_pace: string | null
          current_vdot: number | null
          dashboard_insights: Json | null
          days_per_week: number | null
          external_plan_notes: string | null
          fitness_level: string | null
          goal: string | null
          goal_distance_miles: number | null
          goal_time_minutes: number | null
          hr_zone_method: string
          id: string
          injury_body_parts: string[] | null
          injury_notes: string | null
          last_morning_reminder_date: string | null
          last_nightly_reminder_date: string | null
          lthr_confidence: string | null
          lthr_estimate: number | null
          lthr_history: Json | null
          lthr_last_updated: string | null
          lthr_source: string | null
          manual_prs: Json | null
          preferred_units: string
          proactive_cadence: string | null
          race_date: string | null
          skip_dates: string[] | null
          terrain_type: string | null
          this_week_override_days: string[] | null
          this_week_override_expires: string | null
          training_days: string[] | null
          training_tools: string[] | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          coaching_mode?: string
          constraints?: string | null
          crosstraining_tools?: string[] | null
          current_easy_pace?: string | null
          current_interval_pace?: string | null
          current_tempo_pace?: string | null
          current_vdot?: number | null
          dashboard_insights?: Json | null
          days_per_week?: number | null
          external_plan_notes?: string | null
          fitness_level?: string | null
          goal?: string | null
          goal_distance_miles?: number | null
          goal_time_minutes?: number | null
          hr_zone_method?: string
          id?: string
          injury_body_parts?: string[] | null
          injury_notes?: string | null
          last_morning_reminder_date?: string | null
          last_nightly_reminder_date?: string | null
          lthr_confidence?: string | null
          lthr_estimate?: number | null
          lthr_history?: Json | null
          lthr_last_updated?: string | null
          lthr_source?: string | null
          manual_prs?: Json | null
          preferred_units?: string
          proactive_cadence?: string | null
          race_date?: string | null
          skip_dates?: string[] | null
          terrain_type?: string | null
          this_week_override_days?: string[] | null
          this_week_override_expires?: string | null
          training_days?: string[] | null
          training_tools?: string[] | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          coaching_mode?: string
          constraints?: string | null
          crosstraining_tools?: string[] | null
          current_easy_pace?: string | null
          current_interval_pace?: string | null
          current_tempo_pace?: string | null
          current_vdot?: number | null
          dashboard_insights?: Json | null
          days_per_week?: number | null
          external_plan_notes?: string | null
          fitness_level?: string | null
          goal?: string | null
          goal_distance_miles?: number | null
          goal_time_minutes?: number | null
          hr_zone_method?: string
          id?: string
          injury_body_parts?: string[] | null
          injury_notes?: string | null
          last_morning_reminder_date?: string | null
          last_nightly_reminder_date?: string | null
          lthr_confidence?: string | null
          lthr_estimate?: number | null
          lthr_history?: Json | null
          lthr_last_updated?: string | null
          lthr_source?: string | null
          manual_prs?: Json | null
          preferred_units?: string
          proactive_cadence?: string | null
          race_date?: string | null
          skip_dates?: string[] | null
          terrain_type?: string | null
          this_week_override_days?: string[] | null
          this_week_override_expires?: string | null
          training_days?: string[] | null
          training_tools?: string[] | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      training_state: {
        Row: {
          current_phase: string | null
          current_week: number | null
          id: string
          injury_hold_since: string | null
          last_activity_date: string | null
          last_activity_summary: Json | null
          long_run_target: number | null
          plan_adjustments: string | null
          pre_injury_mileage_target: number | null
          taper_peak_miles: number | null
          updated_at: string | null
          user_id: string
          week1_start_date: string | null
          week_mileage_so_far: number | null
          weekly_long_run_miles: number | null
          weekly_mileage_target: number | null
          weekly_plan_sessions: Json | null
          weekly_quality_session: string | null
        }
        Insert: {
          current_phase?: string | null
          current_week?: number | null
          id?: string
          injury_hold_since?: string | null
          last_activity_date?: string | null
          last_activity_summary?: Json | null
          long_run_target?: number | null
          plan_adjustments?: string | null
          pre_injury_mileage_target?: number | null
          taper_peak_miles?: number | null
          updated_at?: string | null
          user_id: string
          week1_start_date?: string | null
          week_mileage_so_far?: number | null
          weekly_long_run_miles?: number | null
          weekly_mileage_target?: number | null
          weekly_plan_sessions?: Json | null
          weekly_quality_session?: string | null
        }
        Update: {
          current_phase?: string | null
          current_week?: number | null
          id?: string
          injury_hold_since?: string | null
          last_activity_date?: string | null
          last_activity_summary?: Json | null
          long_run_target?: number | null
          plan_adjustments?: string | null
          pre_injury_mileage_target?: number | null
          taper_peak_miles?: number | null
          updated_at?: string | null
          user_id?: string
          week1_start_date?: string | null
          week_mileage_so_far?: number | null
          weekly_long_run_miles?: number | null
          weekly_mileage_target?: number | null
          weekly_plan_sessions?: Json | null
          weekly_quality_session?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "training_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          billing_enabled: boolean
          created_at: string | null
          dashboard_announcement_sent_at: string | null
          dashboard_token: string | null
          dunning_sent_count: number
          first_dunning_sent_at: string | null
          id: string
          linq_chat_id: string | null
          messaging_opted_out: boolean
          name: string | null
          onboarding_data: Json | null
          onboarding_step: string | null
          payment_link_sent_at: string | null
          phone_number: string
          reengagement_sent_at: string | null
          strava_access_token: string | null
          strava_athlete_id: number | null
          strava_refresh_token: string | null
          strava_token_expires_at: string | null
          strava_write_enabled: boolean | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string | null
          timezone: string | null
          trial_started_at: string | null
          v2_migration_sent_at: string | null
        }
        Insert: {
          billing_enabled?: boolean
          created_at?: string | null
          dashboard_announcement_sent_at?: string | null
          dashboard_token?: string | null
          dunning_sent_count?: number
          first_dunning_sent_at?: string | null
          id?: string
          linq_chat_id?: string | null
          messaging_opted_out?: boolean
          name?: string | null
          onboarding_data?: Json | null
          onboarding_step?: string | null
          payment_link_sent_at?: string | null
          phone_number: string
          reengagement_sent_at?: string | null
          strava_access_token?: string | null
          strava_athlete_id?: number | null
          strava_refresh_token?: string | null
          strava_token_expires_at?: string | null
          strava_write_enabled?: boolean | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          timezone?: string | null
          trial_started_at?: string | null
          v2_migration_sent_at?: string | null
        }
        Update: {
          billing_enabled?: boolean
          created_at?: string | null
          dashboard_announcement_sent_at?: string | null
          dashboard_token?: string | null
          dunning_sent_count?: number
          first_dunning_sent_at?: string | null
          id?: string
          linq_chat_id?: string | null
          messaging_opted_out?: boolean
          name?: string | null
          onboarding_data?: Json | null
          onboarding_step?: string | null
          payment_link_sent_at?: string | null
          phone_number?: string
          reengagement_sent_at?: string | null
          strava_access_token?: string | null
          strava_athlete_id?: number | null
          strava_refresh_token?: string | null
          strava_token_expires_at?: string | null
          strava_write_enabled?: boolean | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          timezone?: string | null
          trial_started_at?: string | null
          v2_migration_sent_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
