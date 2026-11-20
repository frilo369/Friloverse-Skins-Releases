// GitHub's two addresses that cost none of its API limit, as the app reads them.
const packet=line=>`${(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')}${line}`;

/** Git's list of references: the service line, then each ref, the first carrying git's options. */
export function refsBody(refs){
  const [[firstName,firstSha],...rest]=Object.entries(refs);
  return `${packet('# service=git-upload-pack\n')}0000${packet(`${firstSha} ${firstName}\0multi_ack thin-pack\n`)}${rest.map(([name,sha])=>packet(`${sha} ${name}\n`)).join('')}0000`;
}
export const refsResponse=refs=>new Response(refsBody(refs));
/** `/releases/latest`: a redirect to the release's tag, or to the list when there is none. */
export const releaseResponse=(repository,tag='')=>new Response(null,{status:302,headers:{location:`https://github.com/${repository}/releases${tag?`/tag/${tag}`:''}`}});
