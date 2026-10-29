-- ============================================================
-- AI 起名 数据表：Supabase SQL Editor 里直接执行即可
-- 表结构对应 api/name.js 中的插入字段
-- ============================================================

-- 1) 建表：记录每次起名的需求 / 生成方案 / 使用模型
create table if not exists public.name_generations (
  id          bigint generated always as identity primary key,  -- 自增主键
  created_at  timestamptz not null default now(),               -- 记录时间
  requirement text        not null,                             -- 用户起名需求
  model       text        not null,                             -- 使用的模型（如 Qwen/Qwen2.5-7B-Instruct）
  result_json jsonb,                                            -- 生成的名字方案：[{"name":"..","meaning":".."}, ...]
  raw_text    text,                                             -- 模型原始流式输出
  source_ip   text                                              -- 可选：来源 IP（如需记录可写入）
);

-- 2) 常用查询索引
create index if not exists idx_name_gen_created
  on public.name_generations (created_at desc);

create index if not exists idx_name_gen_model
  on public.name_generations (model);

-- 3) 开启行级安全（RLS）
--    注意：后端写入用的是 Service Role Key，Service Role 默认绕过 RLS，
--    因此开启 RLS 不影响本项目的服务端写入。
alter table public.name_generations enable row level security;

-- 4) （可选，默认不开启）如果你想允许「匿名/前端 anon key」读取历史记录，
--    才需要执行下面这行；由于记录包含用户需求文本，默认建议不开放，按需自行启用。
-- create policy "允许匿名读取名字生成记录"
--   on public.name_generations for select using (true);
