alter table owners add column updated_at text not null default '';
alter table owners add column state_version integer not null default 0;

update owners
set updated_at = created_at
where updated_at = '';
