"""Generate KEL fixtures with keripy for the verifier tests."""
import json, sys
from keri.core import eventing, coring, signing

def digs(signers):
    return [coring.Diger(ser=s.verfer.qb64b).qb64 for s in signers]

def msg(serder, sigers):
    return bytes(eventing.messagize(serder, sigers=sigers))

salter = signing.Salter(raw=b'0123456789abcdef')
s0 = salter.signers(count=3, path='k0', temp=True)   # inception keys
s1 = salter.signers(count=3, path='k1', temp=True)   # committed next keys
sx = salter.signers(count=3, path='kx', temp=True)   # keys never committed

W = ["1/2", "1/2", "1/2"]

# weighted 2-of-3: icp, rot (signed by 2 of the committed keys), ixn
icp = eventing.incept(keys=[s.verfer.qb64 for s in s0], isith=W, ndigs=digs(s1), nsith=W, code=coring.MtrDex.Blake3_256)
pre = icp.pre
icp_sigs = [s0[i].sign(icp.raw, index=i) for i in (0, 2)]
rot = eventing.rotate(pre=pre, keys=[s.verfer.qb64 for s in s1], dig=icp.said, sn=1, isith=W, ndigs=digs(sx), nsith=W)
rot_sigs = [s1[i].sign(rot.raw, index=i) for i in (0, 1)]
ixn = eventing.interact(pre=pre, dig=rot.said, sn=2, data=[])
ixn_sigs = [s1[i].sign(ixn.raw, index=i) for i in (1, 2)]
open('fixtures/weighted.cesr', 'wb').write(msg(icp, icp_sigs) + msg(rot, rot_sigs) + msg(ixn, ixn_sigs))

# weighted, but ixn signed by only 1 of 3
ixn1 = [s1[0].sign(ixn.raw, index=0)]
open('fixtures/weighted-underthreshold.cesr', 'wb').write(msg(icp, icp_sigs) + msg(rot, rot_sigs) + msg(ixn, ixn1))

# rotation to keys that were never committed (pre-rotation violation), validly self-signed
bad = eventing.rotate(pre=pre, keys=[s.verfer.qb64 for s in sx], dig=icp.said, sn=1, isith=W, ndigs=digs(s1), nsith=W)
bad_sigs = [sx[i].sign(bad.raw, index=i) for i in (0, 1)]
open('fixtures/bad-prerotation.cesr', 'wb').write(msg(icp, icp_sigs) + msg(bad, bad_sigs))

# signing material for request signing in the tests
json.dump({
    "aid": pre,
    "current": [s.qb64 for s in s1],   # signer seeds for the keys after rotation
}, open('fixtures/weighted-keys.json', 'w'))
print(pre)
