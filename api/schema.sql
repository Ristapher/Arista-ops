create table if not exists owners (
  email text primary key,
  name text,
  created_at text not null,
  updated_at text not null,
  state_version integer not null default 0
);

create table if not exists customers (
  id text primary key,
  owner_email text not null,
  name text not null,
  phone text,
  email text,
  address text,
  tag text,
  notes text,
  created_at text not null
);

create table if not exists jobs (
  id text primary key,
  owner_email text not null,
  customer_id text not null,
  customer_name text not null,
  scheduled_date text,
  scheduled_time text,
  job_number text,
  issue text not null,
  status text not null,
  notes text,
  amount integer not null default 0,
  photos integer not null default 0,
  created_at text not null
);

create table if not exists estimates (
  id text primary key,
  owner_email text not null,
  customer_id text not null,
  customer_name text not null,
  title text not null,
  total integer not null default 0,
  status text not null,
  notes text,
  created_at text not null
);

create table if not exists invoices (
  id text primary key,
  owner_email text not null,
  customer_id text not null,
  customer_name text not null,
  job_number text,
  total integer not null default 0,
  status text not null,
  notes text,
  payment_link text,
  created_at text not null
);

create table if not exists followups (
  id text primary key,
  owner_email text not null,
  customer_id text not null,
  customer_name text not null,
  type text not null,
  due_date text not null,
  status text not null,
  notes text,
  created_at text not null
);

create index if not exists idx_customers_owner on customers(owner_email);
create index if not exists idx_jobs_owner on jobs(owner_email);
create index if not exists idx_estimates_owner on estimates(owner_email);
create index if not exists idx_invoices_owner on invoices(owner_email);
create index if not exists idx_followups_owner on followups(owner_email);
