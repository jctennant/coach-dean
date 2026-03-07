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
          activity_type: string | null
          average_cadence: number | null
          average_heartrate: number | null
          average_pace: string | null
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
          strava_activity_id: number | null
          suffer_score: number | null
          summary: Json | null
          user_id: string
          workout_type: number | null
        }
        Insert: {
          activity_type?: string | null
          average_cadence?: number | null
          average_heartrate?: number | null
          average_pace?: string | null
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
          strava_activity_id?: number | null
          suffer_score?: number | null
          summary?: Json | null
          user_id: string
          workout_type?: number | null
        }
        Update: {
          activity_type?: string | null
          average_cadence?: number | null
          average_heartrate?: number | null
          average_pace?: string | null
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
          strava_activity_id?: number | null
          suffer_score?: number | null
          summary?: Json | null
          user_id?: string
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
      training_profiles: {
        Row: {
          constraints: string | null
          crosstraining_tools: string[] | null
          current_easy_pace: string | null
          current_interval_pace: string | null
          current_tempo_pace: string | null
          days_per_week: number | null
          fitness_level: string | null
          goal: string | null
          id: string
          injury_notes: string | null
          last_morning_reminder_date: string | null
          last_nightly_reminder_date: string | null
          proactive_cadence: string | null
          race_date: string | null
          training_days: string[] | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          constraints?: string | null
          crosstraining_tools?: string[] | null
          current_easy_pace?: string | null
          current_interval_pace?: string | null
          current_tempo_pace?: string | null
          days_per_week?: number | null
          fitness_level?: string | null
          goal?: string | null
          id?: string
          injury_notes?: string | null
          last_morning_reminder_date?: string | null
          last_nightly_reminder_date?: string | null
          proactive_cadence?: string | null
          race_date?: string | null
          training_days?: string[] | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          constraints?: string | null
          crosstraining_tools?: string[] | null
          current_easy_pace?: string | null
          current_interval_pace?: string | null
          current_tempo_pace?: string | null
          days_per_week?: number | null
          fitness_level?: string | null
          goal?: string | null
          id?: string
          injury_notes?: string | null
          last_morning_reminder_date?: string | null
          last_nightly_reminder_date?: string | null
          proactive_cadence?: string | null
          race_date?: string | null
          training_days?: string[] | null
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
          last_activity_date: string | null
          last_activity_summary: Json | null
          long_run_target: number | null
          plan_adjustments: string | null
          updated_at: string | null
          user_id: string
          week_mileage_so_far: number | null
          weekly_mileage_target: number | null
        }
        Insert: {
          current_phase?: string | null
          current_week?: number | null
          id?: string
          last_activity_date?: string | null
          last_activity_summary?: Json | null
          long_run_target?: number | null
          plan_adjustments?: string | null
          updated_at?: string | null
          user_id: string
          week_mileage_so_far?: number | null
          weekly_mileage_target?: number | null
        }
        Update: {
          current_phase?: string | null
          current_week?: number | null
          id?: string
          last_activity_date?: string | null
          last_activity_summary?: Json | null
          long_run_target?: number | null
          plan_adjustments?: string | null
          updated_at?: string | null
          user_id?: string
          week_mileage_so_far?: number | null
          weekly_mileage_target?: number | null
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
          created_at: string | null
          id: string
          linq_chat_id: string | null
          messaging_opted_out: boolean
          name: string | null
          onboarding_data: Json | null
          onboarding_step: string | null
          phone_number: string
          reengagement_sent_at: string | null
          strava_access_token: string | null
          strava_athlete_id: number | null
          strava_refresh_token: string | null
          strava_token_expires_at: string | null
          timezone: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          linq_chat_id?: string | null
          messaging_opted_out?: boolean
          name?: string | null
          onboarding_data?: Json | null
          onboarding_step?: string | null
          phone_number: string
          reengagement_sent_at?: string | null
          strava_access_token?: string | null
          strava_athlete_id?: number | null
          strava_refresh_token?: string | null
          strava_token_expires_at?: string | null
          timezone?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          linq_chat_id?: string | null
          messaging_opted_out?: boolean
          name?: string | null
          onboarding_data?: Json | null
          onboarding_step?: string | null
          phone_number?: string
          reengagement_sent_at?: string | null
          strava_access_token?: string | null
          strava_athlete_id?: number | null
          strava_refresh_token?: string | null
          strava_token_expires_at?: string | null
          timezone?: string | null
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
