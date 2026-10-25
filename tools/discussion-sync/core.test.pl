use strict;
use warnings;
use Test::More;
use FindBin;
use lib $FindBin::Bin;
use utf8;
use DiscussionSync qw(origin_id body_hash render_mirror parse_mirror classify_comment plan_hash split_gitlab_notes bounded_pages);

my $origin = origin_id('github', 'github-issue', 7, 31);
is($origin, 'github.com/dinered/codexpro:github-issue:7:comment:31', 'identity includes forge, repository and record IDs');
isnt($origin, origin_id('gitlab', 'gitlab-issue', 7, 31), 'forge/project identity prevents collisions');
my $body = 'original discussion text';
my $hash = body_hash($body);
my $envelope = render_mirror($origin, $body, 'sync-gl', 'github', 'https://github.com/dinered/codexpro/issues/7#issuecomment-31', 'author', '2026-10-25T01:00:00Z');
my $verified = parse_mirror($envelope, 'sync-gl', 'sync-gl');
is($verified->{state}, 'verified', 'strict generated envelope plus expected API actor is verified');
is($verified->{origin}, $origin, 'origin survives the mirror');
is($verified->{hash}, $hash, 'source body hash survives the mirror');
is(parse_mirror($envelope, 'someone-else', 'sync-gl')->{state}, 'ambiguous', 'wrong API actor is never provenance');
is(parse_mirror('quoted text ' . $envelope, 'sync-gl', 'sync-gl')->{state}, 'ambiguous', 'quoted marker is ambiguous');
is(parse_mirror($envelope . "\nmanual edit", 'sync-gl', 'sync-gl')->{state}, 'ambiguous', 'edited envelope is ambiguous');
is(parse_mirror($envelope . "\n" . $envelope, 'sync-gl', 'sync-gl')->{state}, 'ambiguous', 'duplicate markers are ambiguous');

my $mirror = { body => $envelope, api_actor => 'sync-gl' };
my %base = (origin => $origin, source_body => $body, source_api_actor => 'source-author', source_sync_actor => 'sync-gh',
    target_comments => [$mirror], target_sync_actor => 'sync-gl', source_hash => $hash);
is(classify_comment(%base), 'already_mirrored', 'partial-write retry detects the existing remote marker');
is(classify_comment(%base, source_body => 'edited source', source_hash => body_hash('edited source')), 'source_revision', 'edited source becomes a revision, not a duplicate or overwrite');
is(classify_comment(%base, source_body => $envelope, source_api_actor => 'sync-gl', source_sync_actor => 'sync-gl'), 'source_is_mirror', 'reverse traversal does not echo the mirror');
is(classify_comment(%base, target_comments => [{ body => $envelope . "\nedit", api_actor => 'sync-gl' }]), 'conflict', 'concurrent target edit fails closed');
is(classify_comment(%base, target_comments => []), 'create', 'missing mirror is planned for creation');

my $regular = [{id=>1,body=>'ordinary'}, {id=>2,body=>'inline duplicate'}, {id=>3,system=>1}, {id=>4,body=>'thread note'}];
my $discussions = [{id=>'thread-a',resolved=>1,notes=>[{id=>2,position=>{new_path=>'src/a.js'}},{id=>4,system=>0}]}];
my ($notes, $inline) = split_gitlab_notes($regular, $discussions);
is_deeply([map { $_->{id} } @$notes], [1,4], 'only inline note is removed from ordinary notes; ordinary discussion note remains');
is_deeply([map { $_->{note}{id} } @$inline], [2], 'inline note occurs once with its discussion metadata');
is(plan_hash({b=>2,a=>1}), plan_hash({a=>1,b=>2}), 'plan guard hash is deterministic');
is(length(plan_hash({a=>1})), 64, 'plan guard is SHA-256');
isnt(body_hash('текст'), body_hash('text'), 'UTF-8 source bodies produce distinct stable hashes');
my $page_rows = bounded_pages(sub { return $_[0] == 1 ? [ (1..100) ] : [101] }, 2);
is(scalar @$page_rows, 101, 'bounded paginator collects full pages and nested page result');
eval { bounded_pages(sub { return [(1..100)] }, 2) };
like($@, qr/page limit exceeded/, 'pagination limit fails closed');
done_testing();
