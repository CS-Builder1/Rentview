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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      assets: {
        Row: {
          category: string | null
          created_at: string
          expected_life_years: number | null
          id: string
          install_date: string | null
          make: string | null
          model: string | null
          name: string
          notes: string | null
          owner_id: string
          property_id: string
          purchase_cost: number | null
          purchase_currency: string | null
          qr_code: string | null
          serial_number: string | null
          status: Database["public"]["Enums"]["asset_status"]
          unit_id: string | null
          updated_at: string
          warranty_expiry: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          expected_life_years?: number | null
          id?: string
          install_date?: string | null
          make?: string | null
          model?: string | null
          name: string
          notes?: string | null
          owner_id: string
          property_id: string
          purchase_cost?: number | null
          purchase_currency?: string | null
          qr_code?: string | null
          serial_number?: string | null
          status?: Database["public"]["Enums"]["asset_status"]
          unit_id?: string | null
          updated_at?: string
          warranty_expiry?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          expected_life_years?: number | null
          id?: string
          install_date?: string | null
          make?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          owner_id?: string
          property_id?: string
          purchase_cost?: number | null
          purchase_currency?: string | null
          qr_code?: string | null
          serial_number?: string | null
          status?: Database["public"]["Enums"]["asset_status"]
          unit_id?: string | null
          updated_at?: string
          warranty_expiry?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          asset_id: string | null
          created_at: string
          doc_type: Database["public"]["Enums"]["doc_type"]
          id: string
          mime_type: string | null
          name: string
          owner_id: string
          property_id: string | null
          size_bytes: number | null
          storage_path: string
          unit_id: string | null
          work_order_id: string | null
        }
        Insert: {
          asset_id?: string | null
          created_at?: string
          doc_type?: Database["public"]["Enums"]["doc_type"]
          id?: string
          mime_type?: string | null
          name: string
          owner_id: string
          property_id?: string | null
          size_bytes?: number | null
          storage_path: string
          unit_id?: string | null
          work_order_id?: string | null
        }
        Update: {
          asset_id?: string | null
          created_at?: string
          doc_type?: Database["public"]["Enums"]["doc_type"]
          id?: string
          mime_type?: string | null
          name?: string
          owner_id?: string
          property_id?: string | null
          size_bytes?: number | null
          storage_path?: string
          unit_id?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          category: Database["public"]["Enums"]["expense_category"]
          created_at: string
          currency: string
          description: string | null
          id: string
          incurred_on: string
          is_recurring: boolean
          notes: string | null
          owner_id: string
          property_id: string | null
          receipt_url: string | null
          recurrence: Database["public"]["Enums"]["schedule_freq"] | null
          unit_id: string | null
          updated_at: string
          vendor_id: string | null
          work_order_id: string | null
        }
        Insert: {
          amount: number
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          incurred_on?: string
          is_recurring?: boolean
          notes?: string | null
          owner_id: string
          property_id?: string | null
          receipt_url?: string | null
          recurrence?: Database["public"]["Enums"]["schedule_freq"] | null
          unit_id?: string | null
          updated_at?: string
          vendor_id?: string | null
          work_order_id?: string | null
        }
        Update: {
          amount?: number
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          incurred_on?: string
          is_recurring?: boolean
          notes?: string | null
          owner_id?: string
          property_id?: string | null
          receipt_url?: string | null
          recurrence?: Database["public"]["Enums"]["schedule_freq"] | null
          unit_id?: string | null
          updated_at?: string
          vendor_id?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          cost_currency: string | null
          created_at: string
          id: string
          location: string | null
          low_stock_threshold: number | null
          name: string
          notes: string | null
          owner_id: string
          property_id: string | null
          quantity: number
          sku: string | null
          unit_cost: number | null
          unit_id: string | null
          unit_label: string | null
          updated_at: string
        }
        Insert: {
          cost_currency?: string | null
          created_at?: string
          id?: string
          location?: string | null
          low_stock_threshold?: number | null
          name: string
          notes?: string | null
          owner_id: string
          property_id?: string | null
          quantity?: number
          sku?: string | null
          unit_cost?: number | null
          unit_id?: string | null
          unit_label?: string | null
          updated_at?: string
        }
        Update: {
          cost_currency?: string | null
          created_at?: string
          id?: string
          location?: string | null
          low_stock_threshold?: number | null
          name?: string
          notes?: string | null
          owner_id?: string
          property_id?: string | null
          quantity?: number
          sku?: string | null
          unit_cost?: number | null
          unit_id?: string | null
          unit_label?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_items_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      leases: {
        Row: {
          created_at: string
          deposit_amount: number | null
          end_date: string | null
          id: string
          notes: string | null
          owner_id: string
          rent_amount: number | null
          rent_currency: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["lease_status"]
          tenant_email: string | null
          tenant_name: string
          tenant_phone: string | null
          unit_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deposit_amount?: number | null
          end_date?: string | null
          id?: string
          notes?: string | null
          owner_id: string
          rent_amount?: number | null
          rent_currency?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["lease_status"]
          tenant_email?: string | null
          tenant_name: string
          tenant_phone?: string | null
          unit_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deposit_amount?: number | null
          end_date?: string | null
          id?: string
          notes?: string | null
          owner_id?: string
          rent_amount?: number | null
          rent_currency?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["lease_status"]
          tenant_email?: string | null
          tenant_name?: string
          tenant_phone?: string | null
          unit_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leases_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_schedules: {
        Row: {
          asset_id: string | null
          created_at: string
          description: string | null
          frequency: Database["public"]["Enums"]["schedule_freq"]
          id: string
          interval_days: number | null
          is_active: boolean
          last_done: string | null
          next_due: string | null
          owner_id: string
          property_id: string | null
          title: string
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          created_at?: string
          description?: string | null
          frequency?: Database["public"]["Enums"]["schedule_freq"]
          id?: string
          interval_days?: number | null
          is_active?: boolean
          last_done?: string | null
          next_due?: string | null
          owner_id: string
          property_id?: string | null
          title: string
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          created_at?: string
          description?: string | null
          frequency?: Database["public"]["Enums"]["schedule_freq"]
          id?: string
          interval_days?: number | null
          is_active?: boolean
          last_done?: string | null
          next_due?: string | null
          owner_id?: string
          property_id?: string | null
          title?: string
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_schedules_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          base_currency: string
          country: string | null
          created_at: string
          full_name: string | null
          id: string
          locale: string
          updated_at: string
        }
        Insert: {
          base_currency?: string
          country?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          locale?: string
          updated_at?: string
        }
        Update: {
          base_currency?: string
          country?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          locale?: string
          updated_at?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string | null
          created_at: string
          currency: string
          estimated_value: number | null
          id: string
          name: string
          notes: string | null
          owner_id: string
          postal_code: string | null
          property_type: Database["public"]["Enums"]["property_type"]
          region: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          estimated_value?: number | null
          id?: string
          name: string
          notes?: string | null
          owner_id: string
          postal_code?: string | null
          property_type?: Database["public"]["Enums"]["property_type"]
          region?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          estimated_value?: number | null
          id?: string
          name?: string
          notes?: string | null
          owner_id?: string
          postal_code?: string | null
          property_type?: Database["public"]["Enums"]["property_type"]
          region?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          owner_id: string
          plan: Database["public"]["Enums"]["plan_tier"]
          provider: Database["public"]["Enums"]["sub_provider"]
          provider_customer_id: string | null
          provider_subscription_id: string | null
          status: Database["public"]["Enums"]["sub_status"]
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          owner_id: string
          plan?: Database["public"]["Enums"]["plan_tier"]
          provider: Database["public"]["Enums"]["sub_provider"]
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          owner_id?: string
          plan?: Database["public"]["Enums"]["plan_tier"]
          provider?: Database["public"]["Enums"]["sub_provider"]
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          updated_at?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          is_recurring: boolean
          owner_id: string
          property_id: string | null
          recurrence: Database["public"]["Enums"]["schedule_freq"] | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          is_recurring?: boolean
          owner_id: string
          property_id?: string | null
          recurrence?: Database["public"]["Enums"]["schedule_freq"] | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          is_recurring?: boolean
          owner_id?: string
          property_id?: string | null
          recurrence?: Database["public"]["Enums"]["schedule_freq"] | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      units: {
        Row: {
          bathrooms: number | null
          bedrooms: number | null
          created_at: string
          floor: string | null
          id: string
          label: string
          notes: string | null
          owner_id: string
          property_id: string
          rent_amount: number | null
          rent_currency: string | null
          size_unit: string | null
          size_value: number | null
          status: Database["public"]["Enums"]["unit_status"]
          unit_type: Database["public"]["Enums"]["unit_type"]
          updated_at: string
        }
        Insert: {
          bathrooms?: number | null
          bedrooms?: number | null
          created_at?: string
          floor?: string | null
          id?: string
          label: string
          notes?: string | null
          owner_id: string
          property_id: string
          rent_amount?: number | null
          rent_currency?: string | null
          size_unit?: string | null
          size_value?: number | null
          status?: Database["public"]["Enums"]["unit_status"]
          unit_type?: Database["public"]["Enums"]["unit_type"]
          updated_at?: string
        }
        Update: {
          bathrooms?: number | null
          bedrooms?: number | null
          created_at?: string
          floor?: string | null
          id?: string
          label?: string
          notes?: string | null
          owner_id?: string
          property_id?: string
          rent_amount?: number | null
          rent_currency?: string | null
          size_unit?: string | null
          size_value?: number | null
          status?: Database["public"]["Enums"]["unit_status"]
          unit_type?: Database["public"]["Enums"]["unit_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "units_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          owner_id: string
          phone: string | null
          trade: string | null
          updated_at: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          owner_id: string
          phone?: string | null
          trade?: string | null
          updated_at?: string
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          owner_id?: string
          phone?: string | null
          trade?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      work_order_parts: {
        Row: {
          cost_currency: string | null
          created_at: string
          description: string | null
          id: string
          inventory_item_id: string | null
          owner_id: string
          quantity: number
          unit_cost: number | null
          work_order_id: string
        }
        Insert: {
          cost_currency?: string | null
          created_at?: string
          description?: string | null
          id?: string
          inventory_item_id?: string | null
          owner_id: string
          quantity?: number
          unit_cost?: number | null
          work_order_id: string
        }
        Update: {
          cost_currency?: string | null
          created_at?: string
          description?: string | null
          id?: string
          inventory_item_id?: string | null
          owner_id?: string
          quantity?: number
          unit_cost?: number | null
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_parts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_parts_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          asset_id: string | null
          completed_at: string | null
          cost: number | null
          cost_currency: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          owner_id: string
          priority: Database["public"]["Enums"]["wo_priority"]
          property_id: string
          status: Database["public"]["Enums"]["wo_status"]
          title: string
          unit_id: string | null
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          asset_id?: string | null
          completed_at?: string | null
          cost?: number | null
          cost_currency?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          owner_id: string
          priority?: Database["public"]["Enums"]["wo_priority"]
          property_id: string
          status?: Database["public"]["Enums"]["wo_status"]
          title: string
          unit_id?: string | null
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          asset_id?: string | null
          completed_at?: string | null
          cost?: number | null
          cost_currency?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          owner_id?: string
          priority?: Database["public"]["Enums"]["wo_priority"]
          property_id?: string
          status?: Database["public"]["Enums"]["wo_status"]
          title?: string
          unit_id?: string | null
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      asset_status:
        | "operational"
        | "needs_attention"
        | "out_of_service"
        | "retired"
      doc_type:
        | "lease"
        | "warranty"
        | "receipt"
        | "manual"
        | "invoice"
        | "insurance"
        | "photo"
        | "other"
      expense_category:
        | "repair"
        | "capex"
        | "utility"
        | "supplies"
        | "service"
        | "insurance"
        | "tax"
        | "other"
      lease_status: "active" | "pending" | "expired" | "terminated"
      plan_tier: "free" | "pro"
      property_type: "residential" | "commercial" | "mixed"
      schedule_freq:
        | "daily"
        | "weekly"
        | "monthly"
        | "quarterly"
        | "biannual"
        | "annual"
        | "custom"
      sub_provider: "lemonsqueezy" | "paypal"
      sub_status: "trialing" | "active" | "past_due" | "cancelled" | "expired"
      task_status: "pending" | "in_progress" | "completed" | "cancelled"
      unit_status: "occupied" | "vacant" | "maintenance" | "unavailable"
      unit_type:
        | "apartment"
        | "house"
        | "retail"
        | "office"
        | "storage"
        | "whole_property"
        | "other"
      wo_priority: "low" | "medium" | "high" | "urgent"
      wo_status: "open" | "in_progress" | "on_hold" | "completed" | "cancelled"
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
    Enums: {
      asset_status: [
        "operational",
        "needs_attention",
        "out_of_service",
        "retired",
      ],
      doc_type: [
        "lease",
        "warranty",
        "receipt",
        "manual",
        "invoice",
        "insurance",
        "photo",
        "other",
      ],
      expense_category: [
        "repair",
        "capex",
        "utility",
        "supplies",
        "service",
        "insurance",
        "tax",
        "other",
      ],
      lease_status: ["active", "pending", "expired", "terminated"],
      plan_tier: ["free", "pro"],
      property_type: ["residential", "commercial", "mixed"],
      schedule_freq: [
        "daily",
        "weekly",
        "monthly",
        "quarterly",
        "biannual",
        "annual",
        "custom",
      ],
      sub_provider: ["lemonsqueezy", "paypal"],
      sub_status: ["trialing", "active", "past_due", "cancelled", "expired"],
      task_status: ["pending", "in_progress", "completed", "cancelled"],
      unit_status: ["occupied", "vacant", "maintenance", "unavailable"],
      unit_type: [
        "apartment",
        "house",
        "retail",
        "office",
        "storage",
        "whole_property",
        "other",
      ],
      wo_priority: ["low", "medium", "high", "urgent"],
      wo_status: ["open", "in_progress", "on_hold", "completed", "cancelled"],
    },
  },
} as const
