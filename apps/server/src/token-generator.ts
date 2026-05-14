const BASE_TOKENS = `Distributed systems are one of the most fascinating and challenging areas of modern computer science.
At their core, they involve multiple independent computers working together to appear as a single coherent system to the end user.
This seemingly simple goal hides an enormous amount of complexity beneath the surface.

To understand why distributed systems are hard, we must first appreciate what we are asking them to do.
We want a collection of machines, each with its own memory and processor, connected over an unreliable network, to agree on facts,
make progress under failures, and serve results that look as if they came from one giant reliable computer.
This is, fundamentally, a problem of coordination under uncertainty.

The first major challenge is the network itself.
Networks drop packets, reorder them, duplicate them, and introduce arbitrary delays.
A message sent from node A to node B may arrive in one millisecond or one second, or it may never arrive at all.
Worse, when a response does not come back, node A cannot tell whether node B never received the request,
received it and crashed before responding, or responded and the reply was lost.
This ambiguity is the root cause of most distributed systems complexity.

Leslie Lamport captured this beautifully when he said a distributed system is one in which the failure of a computer
you did not even know existed can render your own computer unusable.
The failure modes in a distributed system are qualitatively different from those in a single machine.
A hard drive either works or it does not. A network link can be partially working, intermittently failing,
or corrupted in subtle ways that are extremely difficult to detect.

Consensus is another foundational problem. If multiple nodes must agree on a single value,
say which server is the current leader, they must do so even when some nodes have crashed
and messages are being delayed. The Paxos algorithm, developed by Lamport in the 1980s,
was the first rigorous solution to this problem. Raft, designed decades later, offers the same guarantees
with a design explicitly optimized for understandability. Both algorithms require a quorum,
meaning a majority of nodes must participate for any decision to be made.
This quorum requirement means that in a cluster of five nodes, two can fail and the system keeps working.
Three failures bring the system to a halt because no majority can form.

The CAP theorem, introduced by Eric Brewer, tells us that a distributed system can provide at most two
of the following three guarantees: consistency, availability, and partition tolerance.
Consistency means every read sees the most recent write. Availability means every request receives a response.
Partition tolerance means the system keeps operating even when the network splits into isolated groups.
Since network partitions are a reality we cannot avoid, practical systems must choose between
consistency and availability when a partition occurs. Systems like ZooKeeper and etcd choose consistency.
Systems like Cassandra and DynamoDB choose availability. Neither choice is wrong. They reflect different priorities.

Replication is how distributed systems achieve fault tolerance. By storing copies of data on multiple nodes,
the system can survive individual node failures without losing data. But replication introduces its own challenges.
If writes go to a single leader which then replicates to followers, what happens when the leader crashes?
The followers must elect a new leader. During the election, the system may be briefly unavailable.
After the election, the new leader must ensure it has all writes the old leader committed.
If the old leader committed a write but crashed before replicating it, that write is lost.
If we wait for a majority of nodes to acknowledge a write before committing it, we avoid data loss
but increase write latency significantly.

Sharding, also called partitioning, is how distributed systems achieve scalability.
Instead of replicating all data to all nodes, we divide the data set into shards,
each stored on a subset of nodes. A user's data might live on shard three,
while another user's data lives on shard seven. The system uses a routing layer
to direct each request to the correct shard. When the data set grows beyond what a single shard can handle,
we reshard, splitting shards into smaller pieces and redistributing data.
Resharding while the system is live and serving traffic is one of the hardest operational challenges in distributed systems.

Observability is critical in distributed systems because failures are subtle and unexpected.
A single slow node can cascade into system-wide latency spikes through a phenomenon called tail latency amplification.
If a request fans out to one hundred backends and waits for all of them,
the overall latency is the maximum of all one hundred, not the average.
The slowest one percent of backends determines the user experience for all requests.
Distributed tracing, pioneered at Google with Dapper and later open-sourced as Jaeger and Zipkin,
allows engineers to follow a single request as it travels across dozens of microservices,
identifying exactly where time is spent and where errors occur.

The rise of cloud computing has made distributed systems accessible to every engineer, not just specialists.
Kubernetes orchestrates containers across fleets of machines. Kafka streams millions of events per second
across replicated partitions. Redis Streams, which power the system you are reading right now,
provide an append-only log with consumer groups, exactly-once delivery semantics,
and the ability to replay any portion of the stream at any time.
These tools abstract away much of the complexity but they do not eliminate it.
Understanding the underlying principles remains essential for building systems that are correct, efficient, and resilient.

The future of distributed systems is being shaped by several exciting trends.
Geo-distributed databases like CockroachDB and Spanner span multiple data centers and even continents,
offering global consistency with remarkably low latency by using GPS clocks and carefully tuned Paxos variants.
Serverless computing pushes the distribution model further, making individual functions the unit of deployment
and letting the infrastructure handle all concerns of placement, scaling, and fault tolerance.
Conflict-free replicated data types, or CRDTs, offer a mathematical framework for data structures
that can be updated concurrently on multiple nodes and merged without conflicts,
eliminating the need for coordination in many common cases.

Whatever the future holds, the core tension in distributed systems will remain the same.
We want systems that are fast, always available, and perfectly consistent.
Physics and mathematics tell us we cannot have all three simultaneously.
Every distributed system is an engineering compromise, a set of deliberate choices about which guarantees matter most
for a given workload, and how to handle the inevitable moments when the network misbehaves
and nodes fail in unexpected ways. Mastering distributed systems means becoming comfortable
with that uncertainty, and building software that remains correct and useful in spite of it.`.trim().split(/\s+/)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function* generateTokens(_message: string): AsyncGenerator<string> {
  for (const token of BASE_TOKENS) {
    await sleep(50 + Math.random() * 100)
    yield token
  }
}
