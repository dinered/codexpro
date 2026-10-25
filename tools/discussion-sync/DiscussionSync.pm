package DiscussionSync;
use strict;
use warnings;
use Exporter 'import';
use Digest::SHA qw(sha256_hex);
use Encode qw(encode);
use JSON::PP qw(encode_json);
our @EXPORT_OK = qw(origin_id body_hash render_mirror parse_mirror classify_comment plan_hash split_gitlab_notes bounded_pages);

sub body_hash { return sha256_hex(encode('UTF-8', defined $_[0] ? $_[0] : '')) }
sub origin_id {
    my ($service, $kind, $object, $comment, $project) = @_;
    $project //= $service eq 'github' ? 'github.com/dinered/codexpro' : 'gitlab.home.arpa/ai-company/codexpro';
    return join(':', $project, $kind, $object, 'comment', $comment);
}
sub _clean_meta { my ($s) = @_; $s = defined $s ? "$s" : 'unknown'; $s =~ s/[\r\n<>]/ /g; return $s }
sub render_mirror {
    my ($origin, $body, $actor, $service, $url, $author, $created) = @_;
    $body //= '';
    my $display = $service eq 'github' ? 'GitHub' : 'GitLab';
    my $marker = sprintf('<!-- codexpro-discussion-sync:v1 origin=%s source-sha256=%s actor=%s -->', $origin, body_hash($body), $actor);
    return sprintf("> Informational mirror from %s\n> Source: %s\n> Original author: %s; created: %s\n\n%s\n\n%s", $display, _clean_meta($url), _clean_meta($author), _clean_meta($created), $body, $marker);
}
sub parse_mirror {
    my ($body, $api_actor, $expected_actor) = @_;
    $body //= '';
    my @mentions = $body =~ /<!-- codexpro-discussion-sync:v1\b[^>]*-->/g;
    return { state => 'none' } unless @mentions;
    my ($origin, $hash, $marker_actor) = $body =~ /(?:^|\n)<!-- codexpro-discussion-sync:v1 origin=([^ ]+) source-sha256=([a-f0-9]{64}) actor=([A-Za-z0-9_.-]+) -->\s*\z/;
    return { state => 'ambiguous' } unless @mentions == 1 && defined $origin;
    return { state => 'ambiguous' } unless defined $api_actor && $api_actor eq $marker_actor && (!defined $expected_actor || $api_actor eq $expected_actor);
    my ($envelope_service, $source_url, $header_author, $created, $payload) = $body =~ /\A> Informational mirror from (GitHub|GitLab)\n> Source: (https?:\/\/[^\n]+)\n> Original author: ([^\n]+); created: ([^\n]+)\n\n([\s\S]*)\n\n<!-- codexpro-discussion-sync:v1 origin=([^ ]+) source-sha256=([a-f0-9]{64}) actor=([A-Za-z0-9_.-]+) -->\z/;
    return { state => 'ambiguous' } unless defined $payload && $origin eq $6 && $hash eq $7 && $marker_actor eq $8;
    return { state => 'ambiguous' } unless body_hash($payload) eq $hash;
    return { state => 'verified', origin => $origin, hash => $hash, actor => $marker_actor, source_url => $source_url };
}
sub classify_comment {
    my (%arg) = @_;
    my $own = parse_mirror($arg{source_body}, $arg{source_api_actor}, $arg{source_sync_actor});
    return 'source_is_mirror' if $own->{state} eq 'verified';
    return 'conflict' if $own->{state} eq 'ambiguous';
    my ($found, $stale, $current_copy, $ambiguous) = (0, 0, 0, 0);
    for my $target (@{$arg{target_comments} // []}) {
        my $m = parse_mirror($target->{body}, $target->{api_actor}, $arg{target_sync_actor});
        $ambiguous = 1 if $m->{state} eq 'ambiguous';
        next unless $m->{state} eq 'verified' && $m->{origin} eq $arg{origin};
        $found = 1;
        $current_copy = 1 if $m->{hash} eq $arg{source_hash};
        $stale = 1;
    }
    return 'conflict' if $ambiguous;
    return 'already_mirrored' if $current_copy;
    return $found && $stale ? 'source_revision' : 'create';
}
sub plan_hash { my ($plan) = @_; return sha256_hex(JSON::PP->new->canonical->utf8->encode($plan)) }
sub bounded_pages {
    my ($fetch, $max_pages) = @_;
    $max_pages //= 100;
    my @all;
    for my $page (1 .. $max_pages) {
        my $batch = $fetch->($page);
        die "API collection response was not an array\n" unless ref($batch) eq 'ARRAY';
        push @all, @$batch;
        return \@all if @$batch < 100;
    }
    die "API pagination page limit exceeded\n";
}
sub split_gitlab_notes {
    my ($ordinary, $discussions) = @_;
    my %inline = map { defined $_->{id} ? ("$_->{id}" => 1) : () }
        grep { $_->{position} } map { @{$_->{notes} // []} } @$discussions;
    my @regular = grep { !$_->{system} && !$inline{"$_->{id}"} } @$ordinary;
    my @threaded = map { my $d = $_; map { +{ discussion => $d, note => $_ } } grep { !$_->{system} && $_->{position} } @{$d->{notes} // []} } @$discussions;
    return (\@regular, \@threaded);
}
1;
