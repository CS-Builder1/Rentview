export type InboxEvent = {
  id: string;
  title: string;
  body: string;
  href: string;
  created_at: string;
  read_at: string | null;
};

export type InboxCursor = { at: string; id: string };
export type ActivityPage = { events: InboxEvent[]; next: InboxCursor | null };

export type InboxLease = {
  thread_id: string;
  can_post: boolean;
  lease_id: string;
  resident_id: string | null;
  property_name: string;
  unit_label: string;
  contact_name: string;
  last_message: string | null;
  latest_at: string | null;
  unread: number;
};

export type LeaseMessage = {
  id: string;
  body: string;
  sender_id: string | null;
  sender_name: string;
  created_at: string;
};

export type InboxFunctions = {
  unread_repair_replies: { Args: Record<never, never>; Returns: {request_id:string; latest_at:string}[] };
  inbox_activity: { Args: { p_before: string | null; p_before_id: string | null; p_limit: number }; Returns: ActivityPage };
  inbox_unread_count: { Args: Record<never, never>; Returns: number };
  inbox_leases: { Args: { p_lease?: string; p_thread?: string }; Returns: InboxLease[] };
  lease_thread: { Args: { p_lease: string; p_resident: string | null; p_thread?: string }; Returns: LeaseMessage[] };
  mark_inbox_read: { Args: { p_id: string }; Returns: undefined };
  mark_thread_read: { Args: { p_href: string; p_through: string }; Returns: undefined };
  send_lease_message: {
    Args: { p_lease: string; p_resident: string; p_id: string; p_body: string };
    Returns: undefined;
  };
};
