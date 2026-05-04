create table if not exists app_state (
  id integer primary key check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  name text not null,
  email text unique,
  role text not null check (role in ('owner', 'bookkeeper', 'senior_bookkeeper')),
  staff_role text not null,
  password_hash text not null,
  magic_token text,
  token_revoked_at timestamptz,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table users add column if not exists magic_token text;
alter table users add column if not exists token_revoked_at timestamptz;
alter table users add column if not exists last_active_at timestamptz;
create unique index if not exists users_magic_token_unique on users (magic_token) where magic_token is not null;

create table if not exists activity_log (
  id text primary key,
  user_id text not null,
  action text not null,
  target text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists activity_log_user_idx on activity_log (user_id, created_at desc);

create table if not exists subscription_plans (
  id text primary key,
  name text not null,
  monthly_fee numeric(12, 2) not null,
  included_hours numeric(8, 2) not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clients (
  id text primary key,
  name text not null,
  contact text not null,
  billing_mode text not null check (billing_mode in ('hourly', 'subscription')),
  hourly_rate numeric(12, 2) not null,
  plan_id text references subscription_plans(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table clients add column if not exists email text;
alter table clients add column if not exists contact_name text;
alter table clients add column if not exists phone text;
alter table clients add column if not exists address_line1 text;
alter table clients add column if not exists address_line2 text;
alter table clients add column if not exists city text;
alter table clients add column if not exists state text;
alter table clients add column if not exists postal_code text;
alter table clients add column if not exists logo_url text;
alter table clients add column if not exists payment_terms text;
alter table clients add column if not exists footer_note text;
alter table clients add column if not exists quickbooks_pay_url text;
alter table clients add column if not exists invoice_show_time_breakdown boolean not null default true;
alter table clients add column if not exists invoice_hide_internal_hours boolean not null default true;
alter table clients add column if not exists invoice_group_by_category boolean not null default false;

create table if not exists client_assignments (
  client_id text not null references clients(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (client_id, user_id)
);

create table if not exists time_entries (
  id text primary key,
  user_id text not null references users(id) on delete restrict,
  client_id text not null references clients(id) on delete restrict,
  entry_date date not null,
  minutes integer not null check (minutes > 0),
  category text not null,
  description text not null default '',
  billable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists checklists (
  id text primary key,
  title text not null,
  client_id text not null references clients(id) on delete cascade,
  assignee_id text not null references users(id) on delete restrict,
  template_id text,
  frequency text,
  due_date date not null,
  viewer_ids text[] not null default '{}',
  editor_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists checklist_items (
  id text primary key,
  checklist_id text not null references checklists(id) on delete cascade,
  label text not null,
  done boolean not null default false,
  sort_order integer not null default 0,
  due_date date,
  assignee_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table checklist_items add column if not exists due_date date;
alter table checklist_items add column if not exists assignee_id text;

create table if not exists checklist_templates (
  id text primary key,
  title text not null,
  client_id text not null references clients(id) on delete cascade,
  assignee_id text not null references users(id) on delete restrict,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annually')),
  next_due_date date not null,
  active boolean not null default true,
  viewer_ids text[] not null default '{}',
  editor_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists checklist_template_items (
  id text primary key,
  template_id text not null references checklist_templates(id) on delete cascade,
  label text not null,
  sort_order integer not null default 0,
  due_date date,
  assignee_id text,
  stage_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table checklist_template_items add column if not exists due_date date;
alter table checklist_template_items add column if not exists assignee_id text;
alter table checklist_template_items add column if not exists stage_id text;

-- Phase 3: workflow stages on templates
create table if not exists checklist_template_stages (
  id text primary key,
  template_id text not null references checklist_templates(id) on delete cascade,
  name text not null,
  assignee_id text,
  offset_days int not null default 0,
  position int not null default 0,
  viewer_ids text[] not null default '{}',
  editor_ids text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists checklist_template_stages_template_idx on checklist_template_stages(template_id);

alter table checklists add column if not exists case_id text;
alter table checklists add column if not exists stage_id text;
alter table checklists add column if not exists stage_index int;
alter table checklists add column if not exists stage_count int;

create table if not exists invoice_drafts (
  id text primary key,
  client_id text not null references clients(id) on delete restrict,
  billing_period text not null,
  status text not null default 'draft',
  total numeric(12, 2) not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, billing_period)
);

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
