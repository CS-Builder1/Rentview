export type AssignmentStatus = "pending" | "accepted" | "declined" | "completed";
export type DispatchAction = "accept" | "decline" | "propose" | "confirm" | "start" | "complete" | "reopen";
export type DispatchJob = {
  work_order_id: string;
  request_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  priority: string;
  work_status: string;
  property_name: string;
  address: string | null;
  unit_label: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_linked: boolean;
  assignment_status: AssignmentStatus | null;
  visit_status: "none" | "proposed" | "confirmed";
  visit_start: string | null;
  visit_end: string | null;
  proposed_by: string | null;
  can_confirm: boolean;
  field_completed_at: string | null;
  completion_notes: string | null;
  completion_photos: string[];
  revision: number;
};

export type DispatchViews = {
  dispatch_jobs: { Row: DispatchJob; Relationships: [] };
};
export type DispatchFunctions = {
  my_dispatch_jobs: { Args: Record<never, never>; Returns: DispatchJob[] };
  create_contractor_invite: { Args: { p_vendor: string }; Returns: string };
  claim_contractor_invite: { Args: { p_code: string }; Returns: string };
  assign_dispatch: {
    Args: { p_work_order: string; p_vendor: string | null; p_instructions?: string | null };
    Returns: undefined;
  };
  act_on_dispatch: {
    Args: {
      p_work_order: string;
      p_revision: number;
      p_action: DispatchAction;
      p_start?: string;
      p_end?: string;
      p_notes?: string;
      p_photos?: string[];
    };
    Returns: undefined;
  };
};
