# OnChainEvents


### OnChainEvent

| Field            | Type                                                                                                                                                                                               | Label | Description                          |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------|--------------------------------------|
| type             | [OnChainEventType](#OnChainEventType)                                                                                                                                                              |       | The type of onchain event            |
| chain_id         | [uint32](#)                                                                                                                                                                                        |       | The chain id for the event           |
| block_number     | [uint32](#)                                                                                                                                                                                        |       | The block number for the event       |
| block_hash       | [bytes](#)                                                                                                                                                                                         |       | The block hash for the event         |
| block_timestamp  | [uint64](#)                                                                                                                                                                                        |       | The block timestamp for the event    |
| transaction_hash | [bytes](#)                                                                                                                                                                                         |       | The transaction hash for the event   |
| log_index        | [uint32](#)                                                                                                                                                                                        |       | The log index for the event          |
| fid              | [uint64](#)                                                                                                                                                                                        |       | The fid the event is associated with |
| body             | [SignerEventBody](#signereventbody), <br> [SignerMigratedEventBody](#signermigratedeventbody), <br> [IdRegisterEventBody](#idregistereventbody), <br>[StorageRentEventBody](#storagerenteventbody) | oneOf |                                      |
| tx_index         | [uint32](#)                                                                                                                                                                                        |       | The tx index for the event           |


<a name="-OnChainEventType"></a>
### OnChainEventType

| Name                       | Number | Description |
|----------------------------|--------|-------------|
| EVENT_TYPE_NONE            | 0      |             |
| EVENT_TYPE_SIGNER          | 1      |             |
| EVENT_TYPE_SIGNER_MIGRATED | 2      |             |
| EVENT_TYPE_ID_REGISTER     | 3      |             |
| EVENT_TYPE_STORAGE_RENT    | 4      |             |


<a name="-SignerEventBody"></a>
### SignerEventBody

| Field         | Type                                | Label | Description                                        |
|---------------|-------------------------------------|-------|----------------------------------------------------|
| key           | [bytes](#)                          |       | The bytes of the public key for the signer         |
| key_type      | [uint32](#)                         |       | The type of the key (currently only set to 1)      |
| event_type    | [SignerEventType](#SignerEventType) |       | The type of the signer event                       |
| metadata      | [bytes](#)                          |       | The metadata associated with the key               |
| metadata_type | [uint32](#)                         |       | The type of the metadata (currently only set to 1) |

<a name="-SignerEventType"></a>
### SignerEventType

| Name                          | Number | Description |
|-------------------------------|--------|-------------|
| SIGNER_EVENT_TYPE_NONE        | 0      |             |
| SIGNER_EVENT_TYPE_ADD         | 1      |             |
| SIGNER_EVENT_TYPE_REMOVE      | 2      |             |
| SIGNER_EVENT_TYPE_ADMIN_RESET | 3      |             |

<a name="-SignerMigratedEventBody"></a>
### SignerMigratedEventBody

| Field       | Type        | Label | Description                                             |
|-------------|-------------|-------|---------------------------------------------------------|
| migrated_at | [uint32](#) |       | The timestamp at which hubs were migrated to OP mainnet |

<a name="-SignerEventBody"></a>
### SignerEventBody

| Field           | Type                                        | Label | Description                                      |
|-----------------|---------------------------------------------|-------|--------------------------------------------------|
| to              | [bytes](#)                                  |       | The address the fid was registers/transferred to |
| event_type      | [IdRegisterEventType](#IdRegisterEventType) |       | The type of the id register event                |
| from            | [bytes](#)                                  |       | The address the transfer originated from         |
| recover_address | [bytes](#)                                  |       | The recovery address for the fid                 |

<a name="-IdRegisterEventType"></a>
### IdRegisterEventType

| Name                                   | Number | Description |
|----------------------------------------|--------|-------------|
| ID_REGISTER_EVENT_TYPE_NONE            | 0      |             |
| ID_REGISTER_EVENT_TYPE_REGISTER        | 1      |             |
| ID_REGISTER_EVENT_TYPE_TRANSFER        | 2      |             |
| ID_REGISTER_EVENT_TYPE_CHANGE_RECOVERY | 3      |             |

<a name="-StorageRentEventBody"></a>
### StorageRentEventBody

| Field  | Type        | Label | Description                                               |
|--------|-------------|-------|-----------------------------------------------------------|
| payer  | [bytes](#)  |       | The address of the payer                                  |
| units  | [uint32](#) |       | The number of units of storage purchased                  |
| expiry | [uint32](#) |       | The timestamp at which these units of storage will expire |




 

 
