-- Read-only aggregate checks. Inspect nonzero counts before validating legacy constraints.
select 'units.property_id ownership' as invariant, count(*) as invalid_rows from public.units c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'leases.unit_id ownership' as invariant, count(*) as invalid_rows from public.leases c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'assets.property_id ownership' as invariant, count(*) as invalid_rows from public.assets c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'assets.unit_id ownership' as invariant, count(*) as invalid_rows from public.assets c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'work_orders.property_id ownership' as invariant, count(*) as invalid_rows from public.work_orders c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'work_orders.unit_id ownership' as invariant, count(*) as invalid_rows from public.work_orders c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'work_orders.asset_id ownership' as invariant, count(*) as invalid_rows from public.work_orders c join public.assets p on p.id=c.asset_id where p.owner_id<>c.owner_id;
select 'work_orders.vendor_id ownership' as invariant, count(*) as invalid_rows from public.work_orders c join public.vendors p on p.id=c.vendor_id where p.owner_id<>c.owner_id;
select 'inventory_items.property_id ownership' as invariant, count(*) as invalid_rows from public.inventory_items c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'inventory_items.unit_id ownership' as invariant, count(*) as invalid_rows from public.inventory_items c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'work_order_parts.work_order_id ownership' as invariant, count(*) as invalid_rows from public.work_order_parts c join public.work_orders p on p.id=c.work_order_id where p.owner_id<>c.owner_id;
select 'work_order_parts.inventory_item_id ownership' as invariant, count(*) as invalid_rows from public.work_order_parts c join public.inventory_items p on p.id=c.inventory_item_id where p.owner_id<>c.owner_id;
select 'expenses.property_id ownership' as invariant, count(*) as invalid_rows from public.expenses c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'expenses.unit_id ownership' as invariant, count(*) as invalid_rows from public.expenses c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'expenses.work_order_id ownership' as invariant, count(*) as invalid_rows from public.expenses c join public.work_orders p on p.id=c.work_order_id where p.owner_id<>c.owner_id;
select 'expenses.vendor_id ownership' as invariant, count(*) as invalid_rows from public.expenses c join public.vendors p on p.id=c.vendor_id where p.owner_id<>c.owner_id;
select 'maintenance_schedules.property_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_schedules c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'maintenance_schedules.unit_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_schedules c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'maintenance_schedules.asset_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_schedules c join public.assets p on p.id=c.asset_id where p.owner_id<>c.owner_id;
select 'documents.property_id ownership' as invariant, count(*) as invalid_rows from public.documents c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'documents.unit_id ownership' as invariant, count(*) as invalid_rows from public.documents c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'documents.asset_id ownership' as invariant, count(*) as invalid_rows from public.documents c join public.assets p on p.id=c.asset_id where p.owner_id<>c.owner_id;
select 'documents.work_order_id ownership' as invariant, count(*) as invalid_rows from public.documents c join public.work_orders p on p.id=c.work_order_id where p.owner_id<>c.owner_id;
select 'tasks.property_id ownership' as invariant, count(*) as invalid_rows from public.tasks c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'tasks.unit_id ownership' as invariant, count(*) as invalid_rows from public.tasks c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'tenant_invites.lease_id ownership' as invariant, count(*) as invalid_rows from public.tenant_invites c join public.leases p on p.id=c.lease_id where p.owner_id<>c.owner_id;
select 'maintenance_requests.lease_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_requests c join public.leases p on p.id=c.lease_id where p.owner_id<>c.owner_id;
select 'maintenance_requests.unit_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_requests c join public.units p on p.id=c.unit_id where p.owner_id<>c.owner_id;
select 'maintenance_requests.property_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_requests c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
select 'maintenance_requests.work_order_id ownership' as invariant, count(*) as invalid_rows from public.maintenance_requests c join public.work_orders p on p.id=c.work_order_id where p.owner_id<>c.owner_id;
select 'rent_payments.lease_id ownership' as invariant, count(*) as invalid_rows from public.rent_payments c join public.leases p on p.id=c.lease_id where p.owner_id<>c.owner_id;
select 'announcements.property_id ownership' as invariant, count(*) as invalid_rows from public.announcements c join public.properties p on p.id=c.property_id where p.owner_id<>c.owner_id;
-- Special numeric values can survive old numeric(p,s) columns even though the
-- UI expects finite numbers. Retain them for explicit reconciliation before
-- validating the new finite constraints; do not silently replace them with0.
select 'properties.estimated_value finite' as invariant, count(*) as invalid_rows from public.properties where estimated_value in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric);
select 'units.bathrooms finite' as invariant, count(*) as invalid_rows from public.units where bathrooms in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric);
select 'assets.purchase_cost finite' as invariant, count(*) as invalid_rows from public.assets where purchase_cost in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric);
select 'work_orders.cost finite' as invariant, count(*) as invalid_rows from public.work_orders where cost in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric);
