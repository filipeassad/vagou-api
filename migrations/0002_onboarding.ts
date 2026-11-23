import { sql, type Kysely } from 'kysely';

/**
 * Modelo de dados da spec 001: onboarding e controle de acesso (plano 001, seção 3).
 *
 * Regras garantidas pelo banco (e não só pela aplicação):
 * - e-mail único sem diferenciar maiúsculas/minúsculas (citext, req. 23)
 * - unidade, bloco e convite sempre do mesmo condomínio do vínculo (chaves compostas, princípio I)
 * - um vínculo ativo por usuário e condomínio; no máximo um síndico e uma portaria
 *   aprovados por condomínio (índices únicos parciais, req. 4 e 5)
 * - morador sempre tem unidade; portaria nunca tem unidade nem permissão de anunciar
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table users (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      email citext not null unique,
      phone text,  -- obrigatório para moradores (validado na API); a portaria não tem
      password_hash text,  -- null até o síndico criado pelo admin definir a senha
      is_admin boolean not null default false,
      failed_login_attempts integer not null default 0,
      locked_until timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table condominiums (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      address text not null,
      public_code text not null unique,
      tenants_can_list_spots boolean not null default true,
      invite_validity_days integer not null default 7 check (invite_validity_days between 1 and 90),
      timezone text not null default 'America/Sao_Paulo',
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table blocks (
      id uuid primary key default gen_random_uuid(),
      condominium_id uuid not null references condominiums (id),
      name text not null,
      created_at timestamptz not null default now(),
      unique (condominium_id, name),
      unique (condominium_id, id)  -- alvo das chaves compostas
    )
  `.execute(db);

  await sql`
    create table units (
      id uuid primary key default gen_random_uuid(),
      condominium_id uuid not null references condominiums (id),
      block_id uuid not null,
      number text not null,
      created_at timestamptz not null default now(),
      unique (block_id, number),
      unique (condominium_id, id),  -- alvo das chaves compostas
      foreign key (condominium_id, block_id) references blocks (condominium_id, id)
    )
  `.execute(db);

  await sql`
    create table memberships (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id),
      condominium_id uuid not null references condominiums (id),
      unit_id uuid,
      role text not null check (role in ('resident', 'manager', 'front_desk')),
      unit_relation text check (unit_relation in ('owner', 'tenant')),
      status text not null check (status in ('pending', 'approved', 'rejected', 'removed')),
      can_list_spots boolean not null default false,
      origin text not null check (origin in ('qr_code', 'invite', 'admin', 'manager')),
      rejection_reason text,
      decided_by uuid references users (id),
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      foreign key (condominium_id, unit_id) references units (condominium_id, id),
      constraint memberships_resident_has_unit check (
        role <> 'resident' or (unit_id is not null and unit_relation is not null)
      ),
      constraint memberships_front_desk_has_no_unit check (
        role <> 'front_desk' or (unit_id is null and unit_relation is null and not can_list_spots)
      )
    )
  `.execute(db);

  await sql`
    create unique index memberships_one_active_per_user
      on memberships (user_id, condominium_id) where status <> 'removed'
  `.execute(db);
  await sql`
    create unique index memberships_one_manager
      on memberships (condominium_id) where role = 'manager' and status = 'approved'
  `.execute(db);
  await sql`
    create unique index memberships_one_front_desk
      on memberships (condominium_id) where role = 'front_desk' and status = 'approved'
  `.execute(db);
  await sql`create index memberships_condominium_status on memberships (condominium_id, status)`.execute(
    db,
  );
  await sql`create index memberships_unit on memberships (unit_id)`.execute(db);

  await sql`
    create table invites (
      id uuid primary key default gen_random_uuid(),
      condominium_id uuid not null references condominiums (id),
      unit_id uuid not null,
      token_hash bytea not null unique,
      unit_relation text not null check (unit_relation in ('owner', 'tenant')),
      can_list_spots boolean not null default false,
      recipient_email citext,
      recipient_phone text,
      created_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz,
      used_by uuid references users (id),
      revoked_at timestamptz,
      foreign key (condominium_id, unit_id) references units (condominium_id, id),
      constraint invites_used_has_user check ((used_at is null) = (used_by is null))
    )
  `.execute(db);
  await sql`create index invites_condominium on invites (condominium_id, created_at desc)`.execute(
    db,
  );

  await sql`
    create table sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id) on delete cascade,
      refresh_token_hash bytea not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      last_used_at timestamptz not null default now(),
      revoked_at timestamptz,
      replaced_by uuid references sessions (id),
      user_agent text
    )
  `.execute(db);
  await sql`create index sessions_user on sessions (user_id)`.execute(db);

  await sql`
    create table password_resets (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id) on delete cascade,
      token_hash bytea not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `.execute(db);
  await sql`create index password_resets_user on password_resets (user_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'password_resets',
    'sessions',
    'invites',
    'memberships',
    'units',
    'blocks',
    'condominiums',
    'users',
  ]) {
    await sql`drop table if exists ${sql.table(table)}`.execute(db);
  }
}
