// automatically generated by the FlatBuffers compiler, do not modify

import * as flatbuffers from 'flatbuffers';



export class GetFollowsByFidRequest {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i:number, bb:flatbuffers.ByteBuffer):GetFollowsByFidRequest {
  this.bb_pos = i;
  this.bb = bb;
  return this;
}

static getRootAsGetFollowsByFidRequest(bb:flatbuffers.ByteBuffer, obj?:GetFollowsByFidRequest):GetFollowsByFidRequest {
  return (obj || new GetFollowsByFidRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

static getSizePrefixedRootAsGetFollowsByFidRequest(bb:flatbuffers.ByteBuffer, obj?:GetFollowsByFidRequest):GetFollowsByFidRequest {
  bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
  return (obj || new GetFollowsByFidRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

fid(index: number):number|null {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? this.bb!.readUint8(this.bb!.__vector(this.bb_pos + offset) + index) : 0;
}

fidLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

fidArray():Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? new Uint8Array(this.bb!.bytes().buffer, this.bb!.bytes().byteOffset + this.bb!.__vector(this.bb_pos + offset), this.bb!.__vector_len(this.bb_pos + offset)) : null;
}

static startGetFollowsByFidRequest(builder:flatbuffers.Builder) {
  builder.startObject(1);
}

static addFid(builder:flatbuffers.Builder, fidOffset:flatbuffers.Offset) {
  builder.addFieldOffset(0, fidOffset, 0);
}

static createFidVector(builder:flatbuffers.Builder, data:number[]|Uint8Array):flatbuffers.Offset {
  builder.startVector(1, data.length, 1);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addInt8(data[i]!);
  }
  return builder.endVector();
}

static startFidVector(builder:flatbuffers.Builder, numElems:number) {
  builder.startVector(1, numElems, 1);
}

static endGetFollowsByFidRequest(builder:flatbuffers.Builder):flatbuffers.Offset {
  const offset = builder.endObject();
  builder.requiredField(offset, 4) // fid
  return offset;
}

static createGetFollowsByFidRequest(builder:flatbuffers.Builder, fidOffset:flatbuffers.Offset):flatbuffers.Offset {
  GetFollowsByFidRequest.startGetFollowsByFidRequest(builder);
  GetFollowsByFidRequest.addFid(builder, fidOffset);
  return GetFollowsByFidRequest.endGetFollowsByFidRequest(builder);
}

unpack(): GetFollowsByFidRequestT {
  return new GetFollowsByFidRequestT(
    this.bb!.createScalarList(this.fid.bind(this), this.fidLength())
  );
}


unpackTo(_o: GetFollowsByFidRequestT): void {
  _o.fid = this.bb!.createScalarList(this.fid.bind(this), this.fidLength());
}
}

export class GetFollowsByFidRequestT {
constructor(
  public fid: (number)[] = []
){}


pack(builder:flatbuffers.Builder): flatbuffers.Offset {
  const fid = GetFollowsByFidRequest.createFidVector(builder, this.fid);

  return GetFollowsByFidRequest.createGetFollowsByFidRequest(builder,
    fid
  );
}
}
