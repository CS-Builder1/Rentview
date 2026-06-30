-- RentView — portfolio seed for the owner's own properties.
--
-- Safe + idempotent:
--   * Keys off the account by EMAIL (no hard-coded user id, no credentials created here).
--   * Does nothing unless that user exists (sign up in the app first).
--   * Skips entirely if the user already has any properties (won't duplicate).
--
-- Currency: USD. Names are generic and meant to be edited in-app.
-- To target a different account, change the email below.

do $$
declare
  v_email text := 'stunner.361@gmail.com';
  v_cur   text := 'USD';
  v_owner uuid;

  -- property ids
  p_complex uuid; p_store1 uuid; p_store2 uuid; p_store3 uuid; p_store4 uuid;
  p_home1 uuid; p_home2 uuid;

  -- unit ids we reference later
  u_apt1a uuid; u_apt2a uuid; u_pent uuid;
  u_store1 uuid; u_store2 uuid;
  u_home2 uuid;

  -- vendor ids
  ven_plumb uuid; ven_elec uuid; ven_ac uuid;

  -- asset ids
  a_ac2a uuid; a_store2ac uuid;
begin
  select id into v_owner from auth.users where email = v_email limit 1;

  if v_owner is null then
    raise notice 'No user found for %, sign up in the app first. Nothing seeded.', v_email;
    return;
  end if;

  if exists (select 1 from public.properties where owner_id = v_owner) then
    raise notice 'User % already has properties. Skipping seed.', v_email;
    return;
  end if;

  -- ---------------------------------------------------------------- properties
  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value, notes)
  values (v_owner, 'Marigot Bay Apartments', 'residential', 'Marigot Bay', v_cur, 1850000,
          'Apartment complex — units differ in size, layout and rent.')
  returning id into p_complex;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Castries Main St Store', 'commercial', 'Castries', v_cur, 950000)
  returning id into p_store1;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Rodney Bay Store', 'commercial', 'Rodney Bay', v_cur, 1100000)
  returning id into p_store2;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Vieux Fort Store', 'commercial', 'Vieux Fort', v_cur, 720000)
  returning id into p_store3;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Gros Islet Store', 'commercial', 'Gros Islet', v_cur, 800000)
  returning id into p_store4;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Family Home — Cap Estate', 'residential', 'Cap Estate', v_cur, 1400000)
  returning id into p_home1;

  insert into public.properties (owner_id, name, property_type, city, currency, estimated_value)
  values (v_owner, 'Rental Home — Soufriere', 'residential', 'Soufriere', v_cur, 980000)
  returning id into p_home2;

  -- --------------------------------------------------------------------- units
  -- Apartment complex: four DIFFERENT units.
  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_complex, 'Apt 1A', 'apartment', 'occupied', 1, 1, 45, 'sqm', 1800, v_cur)
  returning id into u_apt1a;

  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_complex, 'Apt 1B (Studio)', 'apartment', 'vacant', 0, 1, 30, 'sqm', 1400, v_cur);

  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_complex, 'Apt 2A', 'apartment', 'occupied', 2, 1, 65, 'sqm', 2400, v_cur)
  returning id into u_apt2a;

  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_complex, 'Penthouse', 'apartment', 'occupied', 3, 2, 110, 'sqm', 4200, v_cur)
  returning id into u_pent;

  -- Stores: one retail unit each.
  insert into public.units (owner_id, property_id, label, unit_type, status, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_store1, 'Storefront', 'retail', 'occupied', 80, 'sqm', 3500, v_cur)
  returning id into u_store1;

  insert into public.units (owner_id, property_id, label, unit_type, status, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_store2, 'Retail Unit', 'retail', 'occupied', 95, 'sqm', 4000, v_cur)
  returning id into u_store2;

  insert into public.units (owner_id, property_id, label, unit_type, status, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_store3, 'Shop', 'retail', 'vacant', 60, 'sqm', 2800, v_cur);

  insert into public.units (owner_id, property_id, label, unit_type, status, size_value, size_unit, rent_amount, rent_currency)
  values (v_owner, p_store4, 'Shop', 'retail', 'occupied', 70, 'sqm', 3000, v_cur);

  -- Homes: single unit each.
  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms)
  values (v_owner, p_home1, 'Main House', 'house', 'occupied', 4, 3);

  insert into public.units (owner_id, property_id, label, unit_type, status, bedrooms, bathrooms, rent_amount, rent_currency)
  values (v_owner, p_home2, 'Whole House', 'house', 'occupied', 3, 2, 2500, v_cur)
  returning id into u_home2;

  -- ------------------------------------------------------------------- vendors
  insert into public.vendors (owner_id, name, trade, phone)
  values (v_owner, 'Island Plumbing Co.', 'Plumber', '+1-758-555-0101')
  returning id into ven_plumb;

  insert into public.vendors (owner_id, name, trade, phone)
  values (v_owner, 'Bright Spark Electrical', 'Electrician', '+1-758-555-0102')
  returning id into ven_elec;

  insert into public.vendors (owner_id, name, trade, phone)
  values (v_owner, 'CoolAir Services', 'HVAC technician', '+1-758-555-0103')
  returning id into ven_ac;

  -- -------------------------------------------------------------------- assets
  insert into public.assets (owner_id, property_id, unit_id, name, category, make, model, install_date, warranty_expiry, expected_life_years, purchase_cost, purchase_currency, status)
  values (v_owner, p_complex, u_apt2a, 'Split AC unit', 'HVAC', 'Midea', 'MSA-12CR', '2023-05-10', '2026-05-10', 10, 3200, v_cur, 'operational')
  returning id into a_ac2a;

  insert into public.assets (owner_id, property_id, unit_id, name, category, make, install_date, expected_life_years, purchase_cost, purchase_currency, status)
  values (v_owner, p_complex, u_pent, 'Refrigerator', 'Appliance', 'Samsung', '2022-11-01', 12, 4500, v_cur, 'operational');

  -- Property-level (shared) asset: no unit.
  insert into public.assets (owner_id, property_id, name, category, install_date, expected_life_years, status, notes)
  values (v_owner, p_complex, 'Roof & gutters', 'Structure', '2018-01-01', 25, 'needs_attention', 'Inspect after rainy season.');

  insert into public.assets (owner_id, property_id, unit_id, name, category, make, install_date, warranty_expiry, expected_life_years, purchase_cost, purchase_currency, status)
  values (v_owner, p_store2, u_store2, 'Storefront AC', 'HVAC', 'LG', '2024-02-15', '2027-02-15', 10, 5200, v_cur, 'operational')
  returning id into a_store2ac;

  -- --------------------------------------------------------------- work orders
  insert into public.work_orders (owner_id, property_id, unit_id, vendor_id, title, description, priority, status)
  values (v_owner, p_complex, u_apt1a, ven_plumb, 'Leaking kitchen tap', 'Tenant reports a steady drip under the sink.', 'high', 'open');

  insert into public.work_orders (owner_id, property_id, unit_id, asset_id, vendor_id, title, description, priority, status)
  values (v_owner, p_store2, u_store2, a_store2ac, ven_ac, 'Quarterly AC service', 'Routine clean and gas check.', 'medium', 'in_progress');

  insert into public.work_orders (owner_id, property_id, unit_id, asset_id, vendor_id, title, priority, status, completed_at, cost, cost_currency)
  values (v_owner, p_complex, u_apt2a, a_ac2a, ven_ac, 'AC not cooling', 'urgent', 'completed', now() - interval '20 days', 450, v_cur);

  insert into public.work_orders (owner_id, property_id, unit_id, title, description, priority, status)
  values (v_owner, p_home2, u_home2, 'Repaint exterior trim', 'Weathered trim on the south side.', 'low', 'open');

  -- ------------------------------------------------------------------ expenses
  insert into public.expenses (owner_id, property_id, unit_id, category, description, amount, currency, incurred_on)
  values
    (v_owner, p_complex, u_apt2a, 'repair', 'AC compressor repair', 450, v_cur, current_date - 20),
    (v_owner, p_complex, null,    'supplies', 'Cleaning supplies', 120, v_cur, current_date - 12),
    (v_owner, p_store2,  u_store2, 'service', 'AC service contract', 300, v_cur, current_date - 8),
    (v_owner, p_complex, null,    'utility', 'Common-area electricity', 540, v_cur, current_date - 5),
    (v_owner, p_home2,   u_home2, 'capex', 'New water heater', 1800, v_cur, current_date - 30),
    (v_owner, p_store1,  u_store1, 'repair', 'Door lock replacement', 220, v_cur, current_date - 3);

  -- ----------------------------------------------------------------- inventory
  insert into public.inventory_items (owner_id, property_id, name, quantity, unit_label, unit_cost, cost_currency, low_stock_threshold, location)
  values
    (v_owner, p_complex, 'AC filters', 1, 'each', 45, v_cur, 3, 'Storage room'),   -- low stock
    (v_owner, p_complex, 'Light bulbs (LED)', 24, 'each', 8, v_cur, 6, 'Storage room'),
    (v_owner, null,      'White paint (gal)', 2, 'gallon', 90, v_cur, 2, 'Garage'); -- at threshold

  raise notice 'Seeded portfolio for %.', v_email;
end $$;
